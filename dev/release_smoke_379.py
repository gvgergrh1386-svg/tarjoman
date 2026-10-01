"""Installed Chrome fa/en smoke and same-path version upgrade, synthetic data only.

Navigator locale is emulated with CDP on otherwise real installed extensions.
No account, private browser profile, live provider or personal key is used.
"""
import argparse,base64,contextlib,http.server,json,shutil,subprocess,tempfile,threading,time,sys
from pathlib import Path
import run_harness as h

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--extension',type=Path,required=True)
parser.add_argument('--upgrade-from',type=Path)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--liveness-only',action='store_true')
parser.add_argument('--audit-only',action='store_true')
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
release_version=json.loads((args.extension/'manifest.json').read_text('utf8'))['version']
upgrade_version=json.loads((args.upgrade_from/'manifest.json').read_text('utf8'))['version'] if args.upgrade_from else None
checks=[];observations={'expectedReleaseVersion':release_version,'expectedUpgradeVersion':upgrade_version}
for stream in (sys.stdout,sys.stderr):
    if hasattr(stream,'reconfigure'):stream.reconfigure(encoding='utf8',errors='replace')
def check(name,value):
    checks.append({'name':name,'ok':bool(value)});print(('PASS ' if value else 'FAIL ')+name,flush=True)
def evaluate(ws,session,expression):
    r=ws.call('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True},session=session)
    if r.get('exceptionDetails'):raise RuntimeError(json.dumps(r['exceptionDetails'],ensure_ascii=False))
    return r.get('result',{}).get('value')
def eventually(ws,session,expr):
    return evaluate(ws,session,f'(async()=>{{for(let i=0;i<120;i++){{if(await ({expr}))return true;await new Promise(r=>setTimeout(r,50));}}return false;}})()')
@contextlib.contextmanager
def browser(profile,extension):
    port=h.free_port();proc=subprocess.Popen([str(h.find_chrome()),f'--user-data-dir={profile}',f'--remote-debugging-port={port}','--enable-unsafe-extension-debugging','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    ws=None
    try:
        for _ in range(150):
            try:ws=h.cdp.WS(h.cdp.browser_ws(port));break
            except OSError:time.sleep(.1)
        if ws is None:raise RuntimeError('Chrome startup timeout')
        ident=ws.call('Extensions.loadUnpacked',{'path':str(extension.resolve())})['id'];yield ws,ident
    finally:
        if ws:
            try:ws.call('Browser.close')
            except (OSError,RuntimeError):pass
            ws.close()
        try:proc.wait(timeout=10)
        except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
def page(ws,ident,path,locale='en-US'):
    target=ws.call('Target.createTarget',{'url':'about:blank'})['targetId'];session=ws.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId'];ws.call('Runtime.enable',session=session);ws.call('Page.enable',session=session)
    ws.call('Page.addScriptToEvaluateOnNewDocument',{'source':f"Object.defineProperty(navigator,'languages',{{get:()=>[{json.dumps(locale)}]}});Object.defineProperty(navigator,'language',{{get:()=>{json.dumps(locale)}}});"},session=session)
    ws.call('Page.navigate',{'url':f'chrome-extension://{ident}/{path}'},session=session)
    for _ in range(120):
        if evaluate(ws,session,"document.readyState==='complete'&&!!globalThis.GXT?.getSettings"):return session
        time.sleep(.1)
    raise RuntimeError('Extension page failed to load: '+json.dumps(evaluate(ws,session,"({url:location.href,ready:document.readyState,text:document.body?.innerText?.slice(0,200)})")))
def witness(ws,ident):
    for _ in range(80):
        target=next((t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and ident in t['url']),None)
        if target:
            session=ws.call('Target.attachToTarget',{'targetId':target['targetId'],'flatten':True})['sessionId']
            try:return evaluate(ws,session,"({version:chrome.runtime.getManifest().version,localeMigration:typeof GXT.migrateLocaleInstall==='function',catalog:!!GXT.catalogs?.en,language:GXT.i18n?.language(),stableTweets:typeof translateStableTweets==='function'})")
            finally:ws.call('Target.detachFromTarget',{'sessionId':session})
        time.sleep(.1)
    return {'missingWorker':True}
def shot(ws,session,name):
    # Hidden targets may have suspended animation clocks. Screenshot settling
    # must not turn a passed upgrade into an unbounded CDP wait.
    evaluate(ws,session,"Promise.race([Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>null))),new Promise(r=>setTimeout(r,500))]).then(()=>true)")
    data=ws.call('Page.captureScreenshot',{'format':'png'},session=session)['data'];(args.output/name).write_bytes(base64.b64decode(data))
def copy_runtime(src,dst):
    dst.mkdir(exist_ok=True)
    for name in ['background','content','shared','pages','popup','fonts','icons','_locales']:
        if (src/name).exists():shutil.copytree(src/name,dst/name,dirs_exist_ok=True)
    shutil.copy2(src/'manifest.json',dst/'manifest.json')
def native_reload(ws,ident):
    target=ws.call('Target.createTarget',{'url':'chrome://extensions/'})['targetId'];session=ws.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
    time.sleep(.5)
    evaluate(ws,session,"(()=>{const t=document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar')?.shadowRoot?.querySelector('#devMode');if(t&&!t.checked)t.click();return !!t;})()")
    return evaluate(ws,session,f"""(async()=>{{for(let i=0;i<60;i++){{const m=document.querySelector('extensions-manager');const list=m?.shadowRoot?.querySelector('extensions-item-list');const item=[...(list?.shadowRoot?.querySelectorAll('extensions-item')||[])].find(e=>e.id==={json.dumps(ident)});const button=item?.shadowRoot?.querySelector('#dev-reload-button');if(button){{button.click();return true;}}await new Promise(r=>setTimeout(r,100));}}return false;}})()""")

def audit_controls(ws,ident,popup,lang):
    check(lang+' complete popup initialization',eventually(ws,popup,"document.querySelector('#sumEngine').textContent.trim()!=='—'"))
    check(lang+' known restricted extension pages disable page actions with an explanation',evaluate(ws,popup,"['actTranslate','actSummary','actRead','actScreen'].every(id=>document.getElementById(id).disabled)&&!!document.querySelector('#ctxNote').textContent.trim()"))
    nav=evaluate(ws,popup,"[...document.querySelectorAll('.nav-row[data-goto]')].map(e=>({id:e.dataset.goto,label:e.textContent.trim()}))")
    observed=[]
    for row in nav:
        observed.append(evaluate(ws,popup,"(()=>{const row=document.querySelector('.nav-row[data-goto='+"+json.dumps(row['id'])+"+']');row.click();const v=document.querySelector('.view.active');const ok=v.dataset.view==="+json.dumps(row['id'])+"&&!v.hidden&&document.activeElement===v&&v.scrollWidth<=v.clientWidth+1;document.querySelector('#navBack').click();return ok&&document.activeElement===row;})()"))
    observations['navigation-'+lang]=nav
    check(lang+' every popup destination is reachable and Back restores keyboard focus',bool(nav) and all(observed))
    evaluate(ws,popup,"document.querySelector('#appearanceBtn').focus();document.querySelector('#appearanceBtn').click();true")
    check(lang+' appearance dialog contains focus and makes background inert',evaluate(ws,popup,"!document.querySelector('#sheet').classList.contains('hidden')&&document.querySelector('main').inert&&document.activeElement.id==='sheetClose'"))
    ws.call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27},session=popup)
    ws.call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Escape','code':'Escape','windowsVirtualKeyCode':27},session=popup)
    check(lang+' Escape dismisses appearance and returns focus',evaluate(ws,popup,"document.querySelector('#sheet').classList.contains('hidden')&&!document.querySelector('main').inert&&document.activeElement.id==='appearanceBtn'"))
    check(lang+' settings search and clear restore the settings directory',evaluate(ws,popup,"(()=>{const s=document.querySelector('#search');s.value='YouTube';s.dispatchEvent(new Event('input'));const found=document.body.classList.contains('searching')&&document.querySelector('#noResults').classList.contains('hidden');document.querySelector('#searchClear').click();return found&&!document.body.classList.contains('searching')&&document.querySelector('.view.active').dataset.view==='settings';})()"))
    evaluate(ws,popup,"document.querySelector('.nav-row[data-goto=quality]').click();document.querySelector('#memTerm').value='AuditMarker';document.querySelector('#memValue').value='Synthetic manual correction';document.querySelector('#memPin').click();true")
    check(lang+' memory correction reaches real persistent storage',eventually(ws,popup,"GXT.getMemory().then(m=>Object.values(m.terms).some(t=>t.s==='AuditMarker'&&t.pinned))"))
    check(lang+' real backup excludes credentials and retains manual memory',evaluate(ws,popup,"(async()=>{const r=await chrome.runtime.sendMessage({type:'EXPORT_BACKUP',includeKeys:false,includeMemory:true});globalThis.auditBackup=r.data;return r.ok&&r.data.apiKeys.length===0&&!r.data.openaiKey&&!r.data.settings.bridgeToken&&Object.values(r.data.memory.terms).some(t=>t.s==='AuditMarker');})()"))
    evaluate(ws,popup,"document.querySelector('#memClear').click();true")
    check(lang+' memory clear succeeds only after durable removal',eventually(ws,popup,"GXT.getMemory().then(m=>m.count===0&&document.querySelector('#memStatus').classList.contains('ok'))"))
    check(lang+' real backup restore recovers the manual correction',evaluate(ws,popup,"(async()=>{const r=await chrome.runtime.sendMessage({type:'IMPORT_BACKUP',data:auditBackup,mode:'merge'});const m=await GXT.getMemory();return r.ok&&Object.values(m.terms).some(t=>t.s==='AuditMarker'&&t.pinned);})()"))
    evaluate(ws,popup,"document.querySelector('.shell-tab[data-goto=home]').click();document.querySelector('#view-home').focus();document.querySelector('main').scrollTop=0;true")
    shot(ws,popup,lang+'-audit-home.png')

def forced_worker_restart(ws,ident,popup,lang):
    evaluate(ws,popup,"(async()=>{globalThis.auditRestartSettings=await GXT.getSettings();await GXT.setSettings({provider:'google',pageTargetLang:'fr',memoryEnabled:false,qualityMode:false});return true;})()")
    evaluate(ws,popup,"chrome.runtime.sendMessage({type:'GET_STATS'}).then(()=>true)")
    old=next(t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and ident in t['url'])
    worker=ws.call('Target.attachToTarget',{'targetId':old['targetId'],'flatten':True})['sessionId']
    evaluate(ws,worker,"GXT.mt.translateTexts=async texts=>({list:texts.map(()=> 'SYNTHETIC DURABLE TRANSLATION')});true")
    request="chrome.runtime.sendMessage({type:'TRANSLATE_TEXTS',texts:['A durable source for the worker audit.'],kind:'page'})"
    check(lang+' actual worker writes a durable translation',evaluate(ws,popup,request+".then(r=>r.ok&&r.list[0]==='SYNTHETIC DURABLE TRANSLATION')"))
    ws.call('Target.detachFromTarget',{'sessionId':worker})
    ws.call('ServiceWorker.enable',session=popup)
    versions=[]
    for _ in range(100):
        ws.call('Target.getTargets')
        versions=[v for e in ws.events if e.get('method')=='ServiceWorker.workerVersionUpdated' for v in e.get('params',{}).get('versions',[]) if ident in v.get('scriptURL','') and v.get('runningStatus')=='running']
        if versions:break
        time.sleep(.05)
    if not versions:raise RuntimeError('Extension worker version not observed')
    ws.call('ServiceWorker.stopWorker',{'versionId':versions[-1]['versionId']},session=popup)
    stopped=False
    for _ in range(100):
        if not any(t['targetId']==old['targetId'] for t in ws.call('Target.getTargets')['targetInfos']):stopped=True;break
        time.sleep(.05)
    check(lang+' Chrome deliberately terminates the extension worker',stopped)
    check(lang+' a normal message wakes the stopped worker',evaluate(ws,popup,"chrome.runtime.sendMessage({type:'GET_STATS'}).then(r=>r.ok)"))
    new=next(t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and ident in t['url'])
    check(lang+' worker restart creates a fresh JavaScript context',new['targetId']!=old['targetId'])
    worker=ws.call('Target.attachToTarget',{'targetId':new['targetId'],'flatten':True})['sessionId']
    evaluate(ws,worker,"globalThis.auditUnexpectedFetches=0;globalThis.auditRealFetch=fetch;globalThis.fetch=async()=>{auditUnexpectedFetches++;throw Error('Synthetic network prohibition');};true")
    try:
        check(lang+' durable cache survives termination without provider traffic',evaluate(ws,popup,request+".then(r=>r.ok&&r.list[0]==='SYNTHETIC DURABLE TRANSLATION')") and evaluate(ws,worker,'auditUnexpectedFetches===0'))
        check(lang+' worker restart preserves settings and manual memory',evaluate(ws,popup,"(async()=>{const s=await GXT.getSettings(),m=await GXT.getMemory();return s.provider==='google'&&s.pageTargetLang==='fr'&&Object.values(m.terms).some(t=>t.s==='AuditMarker');})()"))
        evaluate(ws,popup,"GXT.setSettings({bridgeEnabled:true}).then(()=>true)")
        evaluate(ws,worker,"globalThis.auditScreen={calls:0,aborts:0};globalThis.fetch=(url,options)=>{auditScreen.calls++;return new Promise((resolve,reject)=>{const cancel=()=>{auditScreen.aborts++;reject(new DOMException('Synthetic screen cancellation','AbortError'));};if(options.signal.aborted)cancel();else options.signal.addEventListener('abort',cancel,{once:true});});};true")
        evaluate(ws,popup,"globalThis.auditScreenReplies=[];globalThis.auditScreenPort=chrome.runtime.connect({name:'gxt-screen-translation'});auditScreenPort.onMessage.addListener(m=>auditScreenReplies.push(m));auditScreenPort.postMessage({image:'data:image/png;base64,AA=='});true")
        check(lang+' real screen port starts the bridge OCR request',eventually(ws,worker,'auditScreen.calls===1'))
        evaluate(ws,popup,'auditScreenPort.disconnect();true')
        check(lang+' closing the native screen port aborts the real bridge fetch',eventually(ws,worker,'auditScreen.aborts===1'))
        check(lang+' cancelled screen operation sends no translation or late reply',evaluate(ws,worker,'auditScreen.calls===1') and evaluate(ws,popup,'auditScreenReplies.length===0'))
    finally:
        evaluate(ws,worker,'globalThis.fetch=auditRealFetch;true')
        ws.call('Target.detachFromTarget',{'sessionId':worker})
        ws.call('ServiceWorker.disable',session=popup)
        evaluate(ws,popup,'GXT.setSettings(auditRestartSettings).then(()=>true)')

def page_cancellation(ws,ident,popup,lang):
    target=next(t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and ident in t['url'])
    worker=ws.call('Target.attachToTarget',{'targetId':target['targetId'],'flatten':True})['sessionId']
    evaluate(ws,worker,"""(()=>{globalThis.auditFetch=fetch;globalThis.auditPage={calls:0,aborted:0};globalThis.fetch=(url,options)=>{auditPage.calls++;return new Promise((resolve,reject)=>{const cancelled=()=>{auditPage.aborted++;reject(new DOMException('Synthetic cancellation','AbortError'));};if(options.signal?.aborted)cancelled();else options.signal?.addEventListener('abort',cancelled,{once:true});});};return true;})()""")
    try:
        evaluate(ws,popup,"""(async()=>{globalThis.auditOldSettings=await GXT.getSettings();await GXT.setSettings({provider:'openai',openaiBaseUrl:'https://synthetic.example/v1',openaiModel:'synthetic-model',openaiFallbackModel:'',qualityMode:false,memoryEnabled:false});globalThis.auditReplies=0;globalThis.auditPort=chrome.runtime.connect({name:'gxt-page-translation'});auditPort.onMessage.addListener(()=>auditReplies++);auditPort.postMessage({texts:Array.from({length:40},(_,i)=>'Cancellation source '+i+' x'.repeat(500))});return true;})()""")
        check(lang+' real page port starts one synthetic provider request',eventually(ws,worker,'auditPage.calls===1'))
        evaluate(ws,popup,'auditPort.disconnect();true')
        check(lang+' real port disconnect aborts the active fetch',eventually(ws,worker,'auditPage.aborted===1'))
        evaluate(ws,worker,'new Promise(r=>setTimeout(()=>r(true),100))')
        check(lang+' stopped real port sends no later batch, retry or response',evaluate(ws,worker,'auditPage.calls===1') and evaluate(ws,popup,'auditReplies===0'))
    finally:
        evaluate(ws,worker,'globalThis.fetch=auditFetch;delete globalThis.auditFetch;true')
        evaluate(ws,popup,'GXT.setSettings(auditOldSettings).then(()=>true)')

def x_recovery(ws,ident,popup,lang):
    target=next(t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and ident in t['url'])
    worker=ws.call('Target.attachToTarget',{'targetId':target['targetId'],'flatten':True})['sessionId']
    evaluate(ws,popup,"""(async()=>{
      globalThis.auditXSettings=await GXT.getSettings();globalThis.auditXKeys=await GXT.getApiKeys();
      await GXT.setSettings({provider:'gemini',model:'gemini-3.8-flash',ttsEngine:'gemini',qualityMode:false,memoryEnabled:false,contextCache:false,batchSize:1,xTargetLang:'fa'});
      await GXT.setApiKeys(['SYNTHETIC_X_SMOKE_KEY']);
      globalThis.auditPorts=[];globalThis.auditReplies=[];
      globalThis.openX=(items,name='gxt-x-translation')=>{const p=chrome.runtime.connect({name});auditPorts.push(p);p.onMessage.addListener(m=>{if(m.t!=='pong')auditReplies.push(m);});p.postMessage(name==='gxt-x-translation'?{items}:items);return p;};
      return true;
    })()""")
    evaluate(ws,worker,"""(()=>{
      globalThis.auditXFetch=fetch;globalThis.auditX={calls:[],aborted:0,mode:'recover'};
      globalThis.fetch=(url,options)=>{
        auditX.calls.push({url,time:Date.now()});
        if(auditX.mode==='hold')return new Promise((resolve,reject)=>{const stop=()=>{auditX.aborted++;reject(new DOMException('Synthetic cancellation','AbortError'));};if(options.signal.aborted)stop();else options.signal.addEventListener('abort',stop,{once:true});});
        if(auditX.calls.length===1)return Promise.resolve(new Response(JSON.stringify({error:{message:'Synthetic overload'}}),{status:503,headers:{'Retry-After':'10'}}));
        return Promise.resolve(new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({r:[{i:0,t:'ترجمهٔ معتبر',sl:'en'}]})}]},finishReason:'STOP'}]})));
      };return true;
    })()""")
    try:
        evaluate(ws,popup,"openX([{id:'pin',text:'Pinned source sentence.',lang:'en',contentId:'x:synthetic-pin'}]);true")
        check(lang+' real X port starts selected Gemini model',eventually(ws,worker,"auditX.calls.length===1&&auditX.calls[0].url.includes('gemini-3.8-flash:')"))
        check(lang+' temporary failure stays pending without a user-visible error',evaluate(ws,popup,'auditReplies.length===0'))
        check(lang+' real X port recovers automatically',evaluate(ws,popup,"(async()=>{for(let i=0;i<220;i++){if(auditReplies.length)return auditReplies[0]?.results?.pin?.ok===true;await new Promise(r=>setTimeout(r,100));}return false;})()"))
        check(lang+' service Retry-After is respected and model never changes',evaluate(ws,worker,"auditX.calls.length===2&&auditX.calls[1].time-auditX.calls[0].time>=10000&&auditX.calls.every(c=>c.url.includes('gemini-3.8-flash:'))"))
        evaluate(ws,popup,"auditPorts.forEach(p=>p.disconnect());auditReplies=[];openX([{id:'pin2',text:'Pinned source sentence.',lang:'en',contentId:'x:synthetic-pin'},{id:'new',text:'New profile source.',lang:'en',contentId:'x:synthetic-new'}]);true")
        check(lang+' real pinned cache translates only the new post',eventually(ws,popup,"auditReplies[0]?.results?.pin2?.cached===true&&auditReplies[0]?.results?.new?.ok===true") and evaluate(ws,worker,'auditX.calls.length===3'))
        evaluate(ws,popup,"auditPorts.forEach(p=>p.disconnect());auditPorts=[];auditReplies=[];true")
        evaluate(ws,worker,"auditX.mode='hold';true")
        evaluate(ws,popup,"openX([{id:'one',text:'Shared pending source.',lang:'en',contentId:'x:synthetic-shared'}]);openX([{id:'two',text:'Shared pending source.',lang:'en',contentId:'x:synthetic-shared'}]);true")
        check(lang+' real X ports share one in-flight provider request',eventually(ws,worker,'auditX.calls.length===4'))
        evaluate(ws,popup,'auditPorts[0].disconnect();new Promise(r=>setTimeout(()=>r(true),100))')
        check(lang+' one X subscriber can leave without aborting the other',evaluate(ws,worker,'auditX.aborted===0&&auditX.calls.length===4'))
        evaluate(ws,popup,'auditPorts[1].disconnect();true')
        check(lang+' last X subscriber aborts the real pending fetch',eventually(ws,worker,'auditX.aborted===1'))
        evaluate(ws,popup,"openX({type:'TTS_SPEAK',text:'خواندن پست'},'gxt-x-action');true")
        check(lang+' X speech owns a cancellable Gemini request',eventually(ws,worker,'auditX.calls.length===5'))
        evaluate(ws,popup,'auditPorts.at(-1).disconnect();true')
        check(lang+' stopping X speech aborts synthesis and frees the queue',eventually(ws,worker,'auditX.aborted===2&&GXT.tts._internal.limiter.active===0'))
        check(lang+' selected model setting is unchanged',evaluate(ws,popup,"GXT.getSettings().then(s=>s.model==='gemini-3.8-flash')"))
        evaluate(ws,popup,"auditPorts.forEach(p=>p.disconnect());auditReplies=[];globalThis.auditCachePort=chrome.runtime.connect({name:'gxt-x-translation'});auditPorts.push(auditCachePort);auditCachePort.onMessage.addListener(m=>auditReplies.push(m));auditCachePort.postMessage({stream:true,items:[{id:'cached',text:'Pinned source sentence.',lang:'en',contentId:'x:synthetic-pin'},{id:'slow-new',text:'A slow new profile post.',lang:'en',contentId:'x:slow-new-profile'}]});true")
        check(lang+' cached X result arrives while its new batch neighbor is still blocked',eventually(ws,popup,"auditReplies.some(m=>m.t==='result'&&m.id==='cached'&&m.result.cached===true)") and eventually(ws,worker,'auditX.calls.length===6'))
        check(lang+' cached X post never receives a translating status',evaluate(ws,popup,"!auditReplies.some(m=>m.t==='pending'&&m.id==='cached')&&auditReplies.some(m=>m.t==='pending'&&m.id==='slow-new')&&!auditReplies.some(m=>m.t==='result'&&m.id==='slow-new')"))
        evaluate(ws,popup,"auditCachePort.postMessage({t:'cancel',id:'slow-new'});true")
        check(lang+' cancelling the remaining X post keeps the delivered cached result',eventually(ws,worker,'auditX.aborted===3') and evaluate(ws,popup,"auditReplies.filter(m=>m.t==='result'&&m.id==='cached').length===1"))
        # The real content controller, renderer, port and durable cache together.
        # Use an isolated synthetic document; no X account or real API request.
        evaluate(ws,worker,"auditX.mode='recover';true")
        evaluate(ws,popup,"auditReplies=[];openX([{id:'ui-seed',text:'Pinned UI cache source.',lang:'en',contentId:JSON.stringify(['x:99011','Pinned UI cache source.',[]])}]);true")
        check(lang+' UI fixture seeds the actual durable X cache',eventually(ws,popup,"auditReplies.some(m=>m.results?.['ui-seed']?.ok)"))
        evaluate(ws,worker,"auditX.mode='hold';globalThis.auditUiCallStart=auditX.calls.length;true")
        evaluate(ws,popup,"""(async()=>{
          await GXT.setSettings({batchSize:8,batchDelayMs:20});
          const frame=document.createElement('iframe');frame.style.cssText='width:600px;height:600px';document.body.prepend(frame);
          globalThis.auditUiFrame=frame;const w=frame.contentWindow,d=frame.contentDocument;
          // about:blank has no injected extension API. Delegate the host's
          // native Chrome API; ports/storage still reach the installed worker.
          w.chrome=chrome;
          d.body.innerHTML='<article id="pin"><header><div data-testid="User-Name">Alice @alice</div><a href="/alice/status/99011"><time>then</time></a></header><div data-testid="tweetText" lang="en">Pinned UI cache source.</div></article><article id="fresh"><header><a href="/alice/status/99012"><time>now</time></a></header><div data-testid="tweetText" lang="en">New UI slow source.</div></article>';
          for(const path of ['shared/settings.js','content/dom.js','content/render.js'])await new Promise((resolve,reject)=>{const s=d.createElement('script');s.src=chrome.runtime.getURL(path);s.onload=resolve;s.onerror=reject;d.head.append(s);});
          w.auditLoading=[];const loading=w.GXT.render.showLoading;w.GXT.render.showLoading=(el,...args)=>{w.auditLoading.push(el.closest('article')?.id);return loading(el,...args);};
          await new Promise((resolve,reject)=>{const s=d.createElement('script');s.src=chrome.runtime.getURL('content/main.js');s.onload=resolve;s.onerror=reject;d.head.append(s);});return true;
        })()""")
        check(lang+' actual X UI renders cached text while the new post is pending',eventually(ws,popup,"auditUiFrame.contentDocument.querySelector('#pin .gxt-text')&&auditUiFrame.contentDocument.querySelector('#fresh .gxt-skel')"))
        observations['x-ui-'+lang]=evaluate(ws,popup,"({runtime:!!auditUiFrame.contentWindow.chrome?.runtime?.id,loads:auditUiFrame.contentWindow.auditLoading,content:auditUiFrame.contentDocument.body.innerText})")
        check(lang+' actual X UI never shows loading on the cached post',evaluate(ws,popup,"!auditUiFrame.contentWindow.auditLoading.includes('pin')") and evaluate(ws,worker,'auditX.calls.length===auditUiCallStart+1'))
        evaluate(ws,popup,"globalThis.auditUiBox=auditUiFrame.contentDocument.querySelector('#pin .gxt-box');auditUiFrame.contentDocument.querySelector('#pin header').replaceChildren();auditUiBox.remove();true")
        check(lang+' actual X UI preserves the same cached box across header and sibling reconstruction',eventually(ws,popup,"auditUiFrame.contentDocument.querySelector('#pin .gxt-box')===auditUiBox") and evaluate(ws,worker,'auditX.calls.length===auditUiCallStart+1'))
        evaluate(ws,popup,"auditUiFrame.contentDocument.querySelector('#fresh .gxt-btn').click();auditUiFrame.remove();true")
        check(lang+' actual X UI cancellation aborts only the unfinished provider request',eventually(ws,worker,'auditX.aborted===4'))
        observations['x-'+lang]=evaluate(ws,worker,'({calls:auditX.calls.length,aborted:auditX.aborted})')
    finally:
        evaluate(ws,popup,'auditPorts.forEach(p=>p.disconnect());true')
        evaluate(ws,worker,'globalThis.fetch=auditXFetch;delete globalThis.auditXFetch;true')
        evaluate(ws,popup,'(async()=>{await GXT.setSettings(auditXSettings);await GXT.setApiKeys(auditXKeys);return true;})()')

def worker_liveness(profile):
    requests=[]
    class SlowProvider(http.server.BaseHTTPRequestHandler):
      def log_message(self,*args):pass
      def do_OPTIONS(self):
        self.send_response(204);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Access-Control-Allow-Methods','POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','*');self.send_header('Access-Control-Allow-Private-Network','true');self.end_headers()
      def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length','0')));requests.append(time.monotonic());time.sleep(36)
        body=json.dumps({'candidates':[{'content':{'parts':[{'text':json.dumps({'r':[{'i':0,'t':'ترجمهٔ معتبر','sl':'en'}]},ensure_ascii=False)}]},'finishReason':'STOP'}]},ensure_ascii=False).encode('utf8')
        try:
          self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Access-Control-Allow-Origin','*');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        except OSError:pass
    server=http.server.ThreadingHTTPServer(('127.0.0.1',0),SlowProvider);server.daemon_threads=True
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
      with browser(profile,args.extension) as (ws,ident):
        popup=page(ws,ident,'popup/popup.html')
        evaluate(ws,popup,"(async()=>{await GXT.setSettings({provider:'gemini',model:'gemini-3.8-flash',contextCache:false,memoryEnabled:false,qualityMode:false});await GXT.setApiKeys(['SYNTHETIC_LIVENESS_KEY']);return true;})()")
        target=next(t for t in ws.call('Target.getTargets')['targetInfos'] if t['type']=='service_worker' and ident in t['url'])
        worker=ws.call('Target.attachToTarget',{'targetId':target['targetId'],'flatten':True})['sessionId']
        evaluate(ws,worker,"globalThis.auditNativeFetch=fetch;globalThis.fetch=(url,options)=>auditNativeFetch("+json.dumps('http://127.0.0.1:'+str(server.server_port)+'/synthetic-provider')+",options);true")
        # An attached worker debugger itself prevents Chrome idle shutdown.
        # Remove it before starting the actual, slow local-network fetch.
        ws.call('Target.detachFromTarget',{'sessionId':worker})
        evaluate(ws,popup,"globalThis.auditLongResult=null;globalThis.auditLongPort=chrome.runtime.connect({name:'gxt-x-translation'});auditLongPort.onMessage.addListener(m=>{if(m.t!=='pong')auditLongResult=m;});globalThis.auditLongPulse=setInterval(()=>auditLongPort.postMessage({t:'ping'}),15000);auditLongPort.postMessage({items:[{id:'slow',contentId:'x:slow-synthetic',text:'A slowly translated source.',lang:'en'}]});true")
        started=time.monotonic();result=None
        while time.monotonic()-started<52:
          result=evaluate(ws,popup,'auditLongResult')
          if result:break
          time.sleep(.25)
        check('worker with no attached debugger survives a real 36-second fetch',bool(result and result.get('results',{}).get('slow',{}).get('ok')))
        check('slow fetch is not duplicated or cut off at thirty seconds',len(requests)==1 and time.monotonic()-started>=35)
        evaluate(ws,popup,'clearInterval(auditLongPulse);auditLongPort.disconnect();true')
        observations['unattached-worker']={'providerRequests':len(requests),'elapsedSeconds':round(time.monotonic()-started,2),'debuggerDetachedBeforeRequest':True}
    finally:
      server.shutdown();server.server_close();thread.join(timeout=2)

try:
  with tempfile.TemporaryDirectory(prefix='tarjoman-release-smoke-') as directory:
    temp=Path(directory)
    for locale,lang,dir_ in ([] if args.liveness_only else [('fa-IR','fa','rtl'),('en-US','en','ltr')]):
      profile=temp/('fresh-'+lang)
      with browser(profile,args.extension) as (ws,ident):
        popup=page(ws,ident,'popup/popup.html',locale);ws.call('Emulation.setDeviceMetricsOverride',{'width':400,'height':650,'deviceScaleFactor':1,'mobile':False},session=popup)
        check(lang+' fresh automatic language and direction',eventually(ws,popup,f"document.documentElement.lang==='{lang}'&&document.documentElement.dir==='{dir_}'&&document.querySelector('#uiLanguage').value==='auto'"))
        check(lang+' unchanged Persian content default',evaluate(ws,popup,"GXT.getSettings().then(s=>s.targetLang==='fa')"))
        check(lang+' popup has no horizontal overflow',evaluate(ws,popup,"document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"))
        check(lang+' native metadata loads',evaluate(ws,popup,"!chrome.runtime.getManifest().name.includes('__MSG_')"))
        current=witness(ws,ident);observations['fresh-'+lang]=current;check(lang+' real new worker code active',current.get('version')==release_version and current.get('localeMigration') and current.get('catalog'))
        observations['browser']=ws.call('Browser.getVersion')
        audit_controls(ws,ident,popup,lang)
        forced_worker_restart(ws,ident,popup,lang)
        errors=[e['params'].get('exceptionDetails',{}).get('text','exception') for e in ws.events if e.get('method')=='Runtime.exceptionThrown']
        check(lang+' audited popup flows have no uncaught browser exceptions',not errors)
        if args.audit_only:continue
        page_cancellation(ws,ident,popup,lang)
        x_recovery(ws,ident,popup,lang)
        check(lang+' Gemini safety setting is explicit and localized',evaluate(ws,popup,"!!document.querySelector('#geminiSafety')?.closest('label')?.textContent.trim()&&document.querySelector('#geminiSafety').options.length===6"))
        shot(ws,popup,lang+'-popup.png')
        workshop=page(ws,ident,'pages/subtitles.html',locale)
        check(lang+' workshop ready',eventually(ws,workshop,"!!document.querySelector('#workshopTargetLang')&&!!document.querySelector('#picker')"))
        evaluate(ws,workshop,"document.querySelector('#workshopCustomPrompt').value='USER EDIT: NASA / https://example.com';")
        opposite='en' if lang=='fa' else 'fa'
        evaluate(ws,popup,"GXT.setSettings({regionLocale:'fa-IR',calendar:'persian',numberingSystem:'arabext'}).then(()=>true)")
        evaluate(ws,popup,f"(()=>{{const el=document.querySelector('#uiLanguage');el.value='{opposite}';el.dispatchEvent(new Event('change',{{bubbles:true}}));return true;}})()")
        check(lang+' live workshop switch keeps user input',eventually(ws,workshop,f"document.documentElement.lang==='{opposite}'&&document.querySelector('#workshopCustomPrompt').value==='USER EDIT: NASA / https://example.com'"))
        check(lang+' UI switch leaves target and regional formats independent',evaluate(ws,workshop,"GXT.getSettings().then(s=>s.targetLang==='fa'&&s.regionLocale==='fa-IR'&&/[۰-۹]/.test(GXT.i18n.number(1234)))"))
        evaluate(ws,workshop,f"GXT.setSettings({{uiLanguage:'{lang}'}}).then(()=>true)")
        check(lang+' live reverse switch',eventually(ws,workshop,f"document.documentElement.lang==='{lang}'"))
        ws.call('Emulation.setDeviceMetricsOverride',{'width':1100,'height':850,'deviceScaleFactor':1,'mobile':False},session=workshop);shot(ws,workshop,lang+'-workshop.png')
        popup=page(ws,ident,'popup/popup.html',locale)
        check(lang+' independent destination controls have localized labels',eventually(ws,popup,"['x','compose','page','image','summary','web','file','manga'].every(k=>document.querySelector('#'+k+'TargetLang')?.closest('label')?.querySelector('span')?.textContent.trim())"))
        evaluate(ws,popup,"(()=>{for(const [id,value]of [['targetLang','fr'],['xTargetLang','ja'],['pageTargetLang','ar'],['ytTargetLang','hi']]){const el=document.querySelector('#'+id);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}return true;})()")
        check(lang+' destination controls persist arbitrary languages independently',eventually(ws,popup,"GXT.getSettings().then(s=>s.targetLang==='fr'&&s.xTargetLang==='ja'&&s.pageTargetLang==='ar'&&s.ytTargetLang==='hi')"))
        evaluate(ws,popup,"(()=>{const el=document.querySelector('#targetLang');el.value='not a language';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()")
        check(lang+' invalid target is rejected without losing the saved choice',evaluate(ws,popup,"GXT.getSettings().then(s=>s.targetLang==='fr'&&!document.querySelector('#targetLang').checkValidity())"))
      with browser(profile,args.extension) as (ws,restarted):
        popup=page(ws,restarted,'popup/popup.html','en-US' if lang=='fa' else 'fa-IR')
        check(lang+' manual choice survives browser restart and opposite locale',eventually(ws,popup,f"document.documentElement.lang==='{lang}'"))
    if not args.audit_only:worker_liveness(temp/'unattached-worker-profile')
    if args.upgrade_from:
      stage=temp/'upgrade-extension';profile=temp/'upgrade-profile';copy_runtime(args.upgrade_from,stage)
      with browser(profile,stage) as (ws,old_id):
        session=page(ws,old_id,'pages/subtitles.html');check('upgrade begins with actual '+upgrade_version,evaluate(ws,session,"chrome.runtime.getManifest().version==="+json.dumps(upgrade_version)+"&&!!GXT.i18n"))
        evaluate(ws,session,"""(async()=>{await GXT.setSettings({uiLanguage:'fa',calendar:'persian',uiTheme:'paper',uiAccent:'rose',ttsModelGemini:'test-model',ytPosX:29,ytPosY:17,webVideoCaptionPosition:{x:33,y:66,manual:true},customPrompt:'upgrade fixture'});await GXT.setApiKeys(['TEST_ONLY_UPGRADE_KEY']);await chrome.storage.local.set({transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',n:3,pinned:true}},count:1}});return true;})()""")
        observations['oldWorker']=witness(ws,old_id)
        fixture=temp/'upgrade.srt';fixture.write_text('1\n00:00:01,000 --> 00:00:03,000\nSynthetic upgrade subtitle.\n',encoding='utf8')
        node=ws.call('DOM.querySelector',{'nodeId':ws.call('DOM.getDocument',session=session)['root']['nodeId'],'selector':'#picker'},session=session)['nodeId'];ws.call('DOM.setFileInputFiles',{'nodeId':node,'files':[str(fixture)]},session=session)
        check('old runtime imports an upgrade project',eventually(ws,session,"!!document.querySelector('#editorRows [data-action=edit]')"))
        evaluate(ws,session,"(()=>{const el=document.querySelector('#editorRows [data-action=edit]');el.value='UPGRADE MANUAL EDIT';el.dispatchEvent(new Event('input',{bubbles:true}));el.blur();return true;})()")
        check('old runtime persists project edit to IndexedDB',eventually(ws,session,"document.querySelector('#saveStatus').textContent.startsWith('ذخیره شد')"))
      copy_runtime(args.extension,stage)
      with browser(profile,stage) as (ws,new_id):
        observations['nativeReloadBeforePage']=native_reload(ws,new_id);time.sleep(.5)
        session=page(ws,new_id,'pages/subtitles.html');evaluate(ws,session,"chrome.runtime.sendMessage({type:'GET_STATS'})");active=witness(ws,new_id)
        if not active.get('localeMigration') or active.get('version')!=release_version:
          observations['nativeReloadClicked']=native_reload(ws,new_id);time.sleep(1);session=page(ws,new_id,'pages/subtitles.html');evaluate(ws,session,"chrome.runtime.sendMessage({type:'GET_STATS'})");active=witness(ws,new_id)
        observations['upgradeWorker']=active
        check('same-path upgrade retains identity',old_id==new_id)
        check('upgrade activates actual new worker code',active.get('version')==release_version and active.get('localeMigration') and active.get('catalog'))
        check('upgrade keeps Persian/IR experience and existing data',evaluate(ws,session,"""(async()=>{const s=await GXT.getSettings(),m=await GXT.getMemory();return s.uiLanguage==='fa'&&s.calendar==='persian'&&s.uiTheme==='paper'&&s.uiAccent==='rose'&&s.ttsModelGemini==='test-model'&&s.ytPosX===29&&s.ytPosY===17&&s.webVideoCaptionPosition.x===33&&s.customPrompt==='upgrade fixture'&&(await GXT.getApiKeys())[0]==='TEST_ONLY_UPGRADE_KEY'&&m.terms.nasa.t==='ناسا';})()"""))
        found=eventually(ws,session,"document.querySelector('#savedProjects').options.length>1")
        if found:evaluate(ws,session,"(()=>{const el=document.querySelector('#savedProjects');el.selectedIndex=1;el.dispatchEvent(new Event('change'));document.querySelector('#restoreProjectBtn').click();return true;})()")
        check('upgraded runtime restores old project and manual lock',found and eventually(ws,session,"document.querySelector('#editorRows [data-action=edit]')?.value==='UPGRADE MANUAL EDIT'&&document.querySelector('#editorRows [data-action=lock]')?.checked"))
        shot(ws,session,'upgrade-workshop.png')
    else:observations['upgrade']='not run: supply --upgrade-from'
except Exception as e:
    check('smoke completed without runtime exception',False);observations['exception']=str(e);print(str(e),flush=True)
finally:
    report={'checks':checks,'observations':observations,'localeMethod':'CDP navigator-language override; actual installed MV3 extension and throwaway profiles; no real provider requests'}
    (args.output/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
sys.exit(any(not c['ok'] for c in checks))
