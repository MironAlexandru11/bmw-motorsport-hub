'use strict';
/**
 * Motorsport Hub — unified single-app BMW MGU suite.
 * Pages: Dyno Live, Drag Timer, Best Times, xDrive, Exhaust.
 *
 * Dyno and drag timing use the upstream project's vehicle signal scaling and
 * drag timer state machine. xDrive and exhaust use the upstream experimental
 * controller modules unchanged. All vehicle-control defaults are DISARMED.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const Car = require('./kit/car');
const { RunTimer } = require('./timer');
const { Controller } = require('./controller');
const { XDriveControl } = require('./xdrive');

const W = 1600, H = 520;
const PAGES = ['Dyno Live', 'Drag Timer', 'Best Times', 'xDrive', 'Exhaust'];
const GO = '#2fd27a';
const MPH = 1.609344;
const SPLITS = [
    { key: '0-50', label: '0–50 km/h', from: 0, to: 50 },
    { key: '0-100', label: '0–100 km/h', from: 0, to: 100 },
    { key: '100-200', label: '100–200 km/h', from: 100, to: 200 },
    { key: '0-200', label: '0–200 km/h', from: 0, to: 200 },
    { key: 'quarter', label: '¼ mile', dist: 402.336 }
];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['rpm', 'speed', 'accel', 'torque', 'gear', 'condition']);
        const exhaust = new Controller(ctx);
        const xdrive = new XDriveControl(ctx, car);

        const dynoFile = path.join(ctx.dataDir, 'motorsport_dyno.json');
        const dragFile = path.join(ctx.dataDir, 'motorsport_drag.json');
        const readJson = (f, d) => { try { return Object.assign(d, JSON.parse(fs.readFileSync(f, 'utf8'))); } catch (_) { return d; } };
        const dynoStore = readJson(dynoFile, { runs: [], baseline: null });
        const dragStore = readJson(dragFile, { best: {}, runs: [] });
        const save = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o)); } catch (e) { log.warn('save: ' + e); } };

        let page = 0, selectedRun = 0, lastDyno = null;
        let dyno = { state: 'idle', power: null, curve: [], peakP: null, peakT: null, peakPrpm: null, peakTrpm: null };
        let pull = [], pullStart = 0, lastSample = 0;
        let timer = null, peakG = 0, lastNewBest = {};
        const splits = () => {
            const mph = settings.get('speedUnit') === 'mph';
            const base = mph ? [
                { key:'0-30mph', label:'0–30 mph', from:0, to:30*MPH },
                { key:'0-60mph', label:'0–60 mph', from:0, to:60*MPH },
                { key:'60-130mph', label:'60–130 mph', from:60*MPH, to:130*MPH },
                { key:'0-100mph', label:'0–100 mph', from:0, to:100*MPH }
            ] : SPLITS.slice(0,4);
            return base.concat([SPLITS[4]]);
        };
        const bestKey = (k) => k + (settings.get('rollout') ? '@ro' : '');
        const newTimer = () => {
            timer = new RunTimer(splits(), {
                rollout: settings.get('rollout'),
                onLaunch: () => { peakG = 0; lastNewBest = {}; },
                onDone: (run) => {
                    lastNewBest = {};
                    Object.keys(run.result).forEach((k) => {
                        const b = dragStore.best[bestKey(k)];
                        if (!b || run.result[k] < b.s) {
                            dragStore.best[bestKey(k)] = { s: run.result[k], at: run.at, trap: run.trap[k] };
                            lastNewBest[k] = true;
                        }
                    });
                    dragStore.runs.unshift(Object.assign({ unit: settings.get('speedUnit') }, run));
                    dragStore.runs = dragStore.runs.slice(0, 30);
                    save(dragFile, dragStore);
                    log.info('drag run saved');
                }
            });
        };
        newTimer();

        const PU = { hp: [745.7, 'hp'], ps: [735.5, 'PS'], kw: [1000, 'kW'] };
        const powerUnit = () => PU[settings.get('powerUnit')] || PU.hp;
        const powerVal = (w) => G.isNum(w) ? w / powerUnit()[0] : null;
        const torqueVal = (n) => G.isNum(n) ? (settings.get('torqueUnit') === 'lbft' ? n * 0.73756 : n) : null;
        const torqueUnit = () => settings.get('torqueUnit') === 'lbft' ? 'lb-ft' : 'Nm';
        const speedVal = (v) => G.isNum(v) ? (settings.get('speedUnit') === 'mph' ? v / MPH : v) : null;
        const speedUnit = () => settings.get('speedUnit') === 'mph' ? 'mph' : 'km/h';
        const fmt = (v, n) => G.isNum(v) ? v.toFixed(n === undefined ? 1 : n) : '--';

        car.onSample((d, now) => {
            if (now - lastSample < 40) return;
            lastSample = now;
            if (G.isNum(d.speed)) {
                timer.feed(now, d.speed);
                if (timer.state === 'run') peakG = Math.max(peakG, Math.abs(d.gLong || 0));
            }
            if (!G.isNum(d.rpm) || !G.isNum(d.speed) || !G.isNum(d.gLong)) return;
            const v = d.speed / 3.6, a = d.gLong * 9.80665, mass = settings.get('weight');
            const cd = ({ coupe:0.62, wagon:0.72, suv:0.95 })[settings.get('body')] || 0.65;
            const wheel = mass * a * v + 0.5 * 1.2 * cd * v*v*v + 0.013 * mass * 9.80665 * v;
            const crank = wheel / (1 - settings.get('loss') / 100);
            if (d.gLong > 0.12 && d.speed > 15 && d.rpm > 1200) {
                dyno.state = 'pull'; dyno.power = crank;
                pull.push({ rpm:d.rpm, p:crank, t:d.torque, speed:d.speed });
                pullStart = pullStart || now;
            } else if (dyno.state === 'pull' && now - (pullStart || now) > 500) {
                finishDyno();
            }
        }, () => { dyno.state = 'idle'; dyno.power = null; pull = []; pullStart = 0; });

        function finishDyno() {
            if (pull.length < 16) { dyno.state = 'idle'; pull = []; pullStart = 0; return; }
            const bins = {};
            pull.forEach(p => { const k = Math.round(p.rpm/100)*100; (bins[k] = bins[k] || []).push(p); });
            const keys = Object.keys(bins).map(Number).sort((a,b)=>a-b);
            const curve = keys.map(k => {
                const a = bins[k], p = a.reduce((s,x)=>s+x.p,0)/a.length;
                return { rpm:k, p, t: p/(k*Math.PI/30), ecu:a.reduce((s,x)=>s+(G.isNum(x.t)?x.t:0),0)/a.length };
            });
            if (curve.length) {
                const pp = curve.reduce((a,b)=>b.p>a.p?b:a), tt = curve.reduce((a,b)=>b.t>a.t?b:a);
                const run = { at:pullStart, curve, peakP:pp.p, peakPrpm:pp.rpm, peakT:tt.t, peakTrpm:tt.rpm,
                    weight:settings.get('weight'), loss:settings.get('loss'), v0:pull[0].speed, v1:pull[pull.length-1].speed };
                dynoStore.runs.unshift(run); dynoStore.runs = dynoStore.runs.slice(0,20);
                save(dynoFile,dynoStore); lastDyno=run; dyno=Object.assign({state:'done'},run);
            }
            pull=[]; pullStart=0;
        }

        const note = (cv,t,s,x,y,col) => cv.text(s,x,y,18,col||t.dim,{font:'label'});
        function frame(cv,t) { G.frame(cv,t,PAGES,page,[car.data().demo && {text:'SIM',color:t.warn}]); }
        function top(cv,t,title,sub) {
            cv.text(title,52,92,22,t.dim,{font:'bold',spacing:2});
            cv.text(sub,1548,92,16,t.dim,{align:'right'});
        }
        function button(cv,t,x,y,w,label,fn,key,color) {
            G.button(cv,t,x,y,w,52,label,fn,{key, color:color||null, primary:!!color});
        }
        function drawDyno(cv,t) {
            const d=car.data(), r=lastDyno || dynoStore.runs[0];
            top(cv,t,'LIVE POWER & TORQUE','FULL-THROTTLE PULL · ONE GEAR');
            G.panel(cv,t,24,112,1040,370,'DYNO SHEET');
            G.panel(cv,t,1080,112,496,370,dyno.state==='pull'?'RECORDING':'PEAK');
            const x=92,y=174,w=900,h=235;
            for(let i=0;i<=4;i++){const yy=y+i*h/4;cv.fillRect(x,yy,w,1,withAlpha(t.tick,.35));}
            if(r && r.curve && r.curve.length>1){
                const maxP=Math.max(100,...r.curve.map(c=>powerVal(c.p)||0))*1.15;
                const maxT=Math.max(100,...r.curve.map(c=>torqueVal(c.t)||0))*1.15;
                const minR=Math.min(...r.curve.map(c=>c.rpm)), maxR=Math.max(...r.curve.map(c=>c.rpm));
                const ptsP=r.curve.map(c=>[x+(c.rpm-minR)/(maxR-minR||1)*w,y+h-(powerVal(c.p)||0)/maxP*h]);
                const ptsT=r.curve.map(c=>[x+(c.rpm-minR)/(maxR-minR||1)*w,y+h-(torqueVal(c.t)||0)/maxT*h]);
                cv.polyline(ptsP,4,t.accent); cv.polyline(ptsT,3,t.accent2);
                cv.text(powerUnit()[1].toUpperCase(),x,y-12,16,t.accent,{font:'bold'});
                cv.text(torqueUnit().toUpperCase(),x+w,y-12,16,t.accent2,{align:'right',font:'bold'});
                cv.text('RPM',x+w/2,y+h+30,17,t.dim,{align:'center'});
            } else {
                cv.text(dyno.state==='pull'?'PULL IN PROGRESS':'WAITING FOR A PULL',x+w/2,y+h/2,30,t.dim,{align:'center',font:'bold'});
                note(cv,t,'Full throttle in one gear · flat road · controlled environment',x+w/2,y+h/2+35,t.dim);
            }
            const liveP=dyno.state==='pull'?powerVal(dyno.power):null;
            const p=r?powerVal(r.peakP):null, tq=r?torqueVal(r.peakT):null;
            cv.text('POWER',1110,170,18,t.dim,{font:'bold',spacing:2});
            cv.text(fmt(liveP!==null?liveP:p,0),1110,250,76,liveP!==null?t.accent:t.text,{font:'num'});
            cv.text(powerUnit()[1]+'  '+(r?'@ '+r.peakPrpm+' RPM':''),1114,280,18,t.dim);
            cv.text('TORQUE',1110,340,18,t.dim,{font:'bold',spacing:2});
            cv.text(fmt(tq,0),1110,410,60,t.accent2,{font:'num'});
            cv.text(torqueUnit()+(r?'  @ '+r.peakTrpm+' RPM':''),1114,438,18,t.dim);
            note(cv,t,'LIVE RPM  '+fmt(d.rpm,0)+'  ·  SPEED  '+fmt(d.speed,0)+' km/h',1110,465);
        }
        function drawDrag(cv,t) {
            const d=car.data(), state=timer.state;
            top(cv,t,'DRAG TIMER','AUTOMATIC LAUNCH DETECTION · INTERPOLATED SPLITS');
            G.panel(cv,t,24,112,470,370,'SPEED');
            G.panel(cv,t,510,112,620,370,'SPEED TRACE');
            G.panel(cv,t,1146,112,430,370,'SPLITS');
            cv.text(fmt(speedVal(d.speed),0),450,250,112,t.text,{align:'right',font:'num'});
            cv.text(speedUnit(),458,250,20,t.dim);
            cv.text(fmt(timer.elapsed(Date.now()),2),450,360,60,t.accent,{align:'right',font:'num'});
            cv.text('SECONDS',450,390,16,t.dim,{align:'right',font:'bold'});
            const stateText={wait:'STOP TO ARM',ready:'READY · LAUNCH',run:'TIMING',done:'FINISHED'}[state]||state.toUpperCase();
            cv.roundRect(50,414,420,42,8,withAlpha(state==='ready'?GO:t.accent,.18));
            cv.text(stateText,260,443,22,state==='ready'?GO:t.accent,{align:'center',font:'bold',spacing:2});
            const tr=timer.trace, x=565,y=180,w=510,h=220;
            for(let i=0;i<=4;i++){const yy=y+i*h/4;cv.fillRect(x,yy,w,1,withAlpha(t.tick,.3));}
            if(tr.length>1){
                const vmax=Math.max(100,...tr.map(p=>p[1]))*1.1, tmax=Math.max(6,tr[tr.length-1][0]);
                const pts=tr.map(p=>[x+p[0]/tmax*w,y+h-p[1]/vmax*h]);
                cv.fillUnder(pts,y+h,withAlpha(t.accent,.12));cv.polyline(pts,3,t.accent);
            } else cv.text('Launch when ready',x+w/2,y+h/2,24,t.dim,{align:'center'});
            splits().forEach((s,i)=>{
                const yy=178+i*62, val=timer.result[s.key];
                cv.text(s.label,1170,yy,20,t.dim,{font:'bold'});
                cv.text(fmt(val,2)+' s',1548,yy+25,28,G.isNum(val)?t.text:t.dim,{align:'right',font:'num'});
            });
        }
        function drawBest(cv,t) {
            top(cv,t,'BEST TIMES','PERSONAL RECORDS · RECENT RUNS');
            G.panel(cv,t,24,112,690,370,'BEST TIMES');
            G.panel(cv,t,730,112,846,370,'RECENT RUNS');
            splits().forEach((s,i)=>{
                const b=dragStore.best[bestKey(s.key)], yy=174+i*62;
                cv.text(s.label,52,yy,22,t.text,{font:'bold'});
                cv.text(b?fmt(b.s,2)+' s':'--.-- s',680,yy+8,32,b?t.accent2:t.dim,{align:'right',font:'num'});
                if(b)note(cv,t,new Date(b.at).toLocaleString(),52,yy+27);
            });
            cv.text('WHEN',758,158,17,t.dim,{font:'bold'});
            cv.text('0–100',1120,158,17,t.dim,{font:'bold'});
            cv.text('100–200',1320,158,17,t.dim,{font:'bold'});
            dragStore.runs.slice(0,6).forEach((r,i)=>{
                const yy=202+i*42;
                cv.text(new Date(r.at).toLocaleTimeString(),758,yy,18,t.text);
                cv.text(fmt(r.result['0-100']||r.result['0-60mph'],2),1190,yy,20,t.accent,{align:'right'});
                cv.text(fmt(r.result['100-200']||r.result['60-130mph'],2),1500,yy,20,t.accent2,{align:'right'});
            });
            button(cv,t,1300,426,220,'RESET BEST',()=>{dragStore.best={};dragStore.runs=[];save(dragFile,dragStore);repaint();},'resetbest',t.crit);
        }
        function drawXdrive(cv,t) {
            const v=xdrive.view();
            top(cv,t,'xDRIVE CONTROL','EXPERIMENTAL · ECU-SPECIFIC');
            G.panel(cv,t,24,112,1000,370,'TRANSFER CASE STATUS');
            G.panel(cv,t,1040,112,536,370,'COMPATIBILITY');
            const mode=v.mode||'UNKNOWN';
            cv.text(mode,78,270,104,mode==='AWD'?t.accent2:mode==='RWD'?GO:t.dim,{font:'bold'});
            cv.text('DSC '+(v.index||'—')+'   ·   LMV '+(v.lmvIndex||'—'),82,315,20,t.dim);
            cv.text('FRONT AXLE TORQUE',82,380,18,t.dim,{font:'bold'});
            cv.text(v.torque?fmt(v.torque.actual,1)+' Nm':'— Nm',82,430,38,t.text,{font:'num'});
            cv.text('Live ECU read-back only; physical clutch state is not independently measured.',82,465,16,t.dim);
            cv.text('ECU',1070,174,18,t.dim,{font:'bold'});
            cv.text(v.unit||v.path.toUpperCase(),1070,206,25,t.text);
            cv.text('STATUS',1070,260,18,t.dim,{font:'bold'});
            cv.text(v.supported===true?'READ SUPPORTED':v.supported===false?'NOT SUPPORTED':'CHECKING',1070,292,22,v.supported===true?GO:t.warn,{font:'bold'});
            cv.text('TESTED PROFILE',1070,348,18,t.dim,{font:'bold'});
            cv.text(v.tested?'Known test index':'Not independently validated',1070,380,19,v.tested?GO:t.warn);
            if(v.note)cv.text(v.note,1070,430,16,t.warn);
            const enabled=settings.get('xdrive')==='on';
            button(cv,t,78,426,240,enabled?'xDRIVE OFF':'ENABLE IN SETTINGS',()=>{if(enabled)xdrive.requestOff().then(repaint);},'xd_off',enabled?t.crit:null);
            button(cv,t,340,426,240, v.onAvailable?'xDRIVE ON':'ON NOT VERIFIED',()=>{if(v.onAvailable)xdrive.requestOn().then(repaint);},'xd_on',v.onAvailable?GO:null);
            if(!enabled)note(cv,t,'xDrive control is disabled by default. Enable Experimental in Settings.',920,493,t.warn);
            else note(cv,t,'Double press to confirm · only tested variants expose ON.',920,493,t.warn);
        }
        function drawExhaust(cv,t) {
            const v=exhaust.view();
            top(cv,t,'EXHAUST FLAP','DME CONTROL · OPEN / CLOSE / OEM');
            G.panel(cv,t,24,112,1552,370,'ACTIVE EXHAUST');
            cv.text(v.confirmed||'UNKNOWN',800,260,88,v.confirmed==='OPEN'?t.accent2:v.confirmed==='CLOSED'?t.crit:t.text,{align:'center',font:'bold',spacing:2});
            cv.text('REQUESTED  '+v.requested+'     ·     '+(v.simulated?'SIMULATED':'REAL ADAPTER'),800,310,20,t.dim,{align:'center'});
            cv.text('DME  '+(v.dme||'NOT IDENTIFIED')+'     ·     LINK  '+v.comm,800,350,18,t.dim,{align:'center'});
            cv.text(v.error||v.pickReason||'Commands are gated by the matched adapter and arm setting.',800,390,17,v.error?t.warn:t.dim,{align:'center'});
            button(cv,t,300,426,250,'EXHAUST ON',()=>exhaust.setMode('OPEN').then(repaint),'ex_open',t.accent);
            button(cv,t,675,426,250,'EXHAUST OFF',()=>exhaust.setMode('CLOSED').then(repaint),'ex_close',t.crit);
            button(cv,t,1050,426,250,'OEM AUTO',()=>exhaust.setMode('OEM').then(repaint),'ex_oem');
            note(cv,t,'Default is disarmed / simulated. Arm only after confirming the DME adapter for your vehicle.',800,506,t.warn);
        }
        function repaint(){return render();}
        async function render() {
            const t=ctx.theme(), cv=ctx.canvas(W,H).clear(t.bg);
            if(page===0)drawDyno(cv,t);
            else if(page===1)drawDrag(cv,t);
            else if(page===2)drawBest(cv,t);
            else if(page===3)drawXdrive(cv,t);
            else drawExhaust(cv,t);
            frame(cv,t);
            await ui.image('MAIN_GFX',cv);
        }
        function flip(delta){page=(page+delta+PAGES.length)%PAGES.length;return render();}
        ui.onClick('BTN_PAGE',()=>flip(1));
        ui.onClick('BTN_PREV',()=>flip(-1));
        ctx.onTab((i)=>{if(i!==page)flip(i-page);});
        ctx.hideButton('BTN_ACTION');
        ui.onClick('BTN_ACTION',()=>page===1?(timer.reset(),peakG=0,render()):page===0?(lastDyno=null,render()):null);
        settings.onChange((key)=>{
            if(['speedUnit','distance','rollout'].indexOf(key)>=0)newTimer();
            if(key==='arm'||key==='xdrive')Promise.resolve(exhaust.refresh()).then(()=>xdrive.refresh()).then(render).catch(e=>log.warn(String(e)));
            else render();
        });

        await exhaust.start();
        await xdrive.start(exhaust.link);
        if(exhaust.link)exhaust.link.onAvailable(()=>exhaust.refresh().then(()=>xdrive.refresh()).then(render).catch(e=>log.warn(String(e))));
        // RunTimer's idle clock advances even when the car sends no new samples at a standstill.
        setInterval(()=>{if(timer)timer.idle(Date.now());},50);
        ctx.loop('MAIN',8,render);
        await render();
        log.info('Motorsport Hub 1.0.0 ready; five integrated pages');
    }
});
