"""Installed Chrome fa/en smoke and same-path 3.7.6 upgrade, synthetic data only.

Navigator locale is emulated with CDP on otherwise real installed extensions.
No account, private browser profile, live provider or personal key is used.
"""
import argparse,base64,contextlib,json,shutil,subprocess,tempfile,time,sys
from pathlib import Path
import run_harness as h

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--extension',type=Path,required=True)
parser.add_argument('--upgrade-from',type=Path)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
checks=[];observations={}
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
    port=h.free_port();proc=subprocess.Popen([str(h.find_chrome()),f'--user-data-dir={profile}',f'--remote-debugging-port={port}','--enable-unsafe-extension-debugging','--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
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
            return evaluate(ws,session,"({version:chrome.runtime.getManifest().version,localeMigration:typeof GXT.migrateLocaleInstall==='function',catalog:!!GXT.catalogs?.en,language:GXT.i18n?.language(),stableTweets:typeof translateStableTweets==='function'})")
        time.sleep(.1)
    return {'missingWorker':True}
def shot(ws,session,name):
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

try:
  with tempfile.TemporaryDirectory(prefix='tarjoman-377-smoke-') as directory:
    temp=Path(directory)
    for locale,lang,dir_ in [('fa-IR','fa','rtl'),('en-US','en','ltr')]:
      profile=temp/('fresh-'+lang)
      with browser(profile,args.extension) as (ws,ident):
        popup=page(ws,ident,'popup/popup.html',locale);ws.call('Emulation.setDeviceMetricsOverride',{'width':400,'height':650,'deviceScaleFactor':1,'mobile':False},session=popup)
        check(lang+' fresh automatic language and direction',eventually(ws,popup,f"document.documentElement.lang==='{lang}'&&document.documentElement.dir==='{dir_}'&&document.querySelector('#uiLanguage').value==='auto'"))
        check(lang+' unchanged Persian content default',evaluate(ws,popup,"GXT.getSettings().then(s=>s.targetLang==='fa')"))
        check(lang+' popup has no horizontal overflow',evaluate(ws,popup,"document.documentElement.scrollWidth<=document.documentElement.clientWidth+1"))
        check(lang+' native metadata loads',evaluate(ws,popup,"!chrome.runtime.getManifest().name.includes('__MSG_')"))
        current=witness(ws,ident);observations['fresh-'+lang]=current;check(lang+' real new worker code active',current.get('version')=='3.7.7' and current.get('localeMigration') and current.get('catalog'))
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
    if args.upgrade_from:
      stage=temp/'upgrade-extension';profile=temp/'upgrade-profile';copy_runtime(args.upgrade_from,stage)
      with browser(profile,stage) as (ws,old_id):
        session=page(ws,old_id,'pages/subtitles.html');check('upgrade begins with actual 3.7.6',evaluate(ws,session,"chrome.runtime.getManifest().version==='3.7.6'&&!GXT.i18n"))
        evaluate(ws,session,"""(async()=>{await GXT.setSettings({uiTheme:'paper',uiAccent:'rose',ttsModelGemini:'test-model',ytPosX:29,ytPosY:17,webVideoCaptionPosition:{x:33,y:66,manual:true},customPrompt:'upgrade fixture'});await GXT.setApiKeys(['TEST_ONLY_UPGRADE_KEY']);await chrome.storage.local.set({transMemory:{terms:{nasa:{s:'NASA',t:'ناسا',n:3,pinned:true}},count:1}});return true;})()""")
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
        if not active.get('localeMigration') or active.get('version')!='3.7.7':
          observations['nativeReloadClicked']=native_reload(ws,new_id);time.sleep(1);session=page(ws,new_id,'pages/subtitles.html');evaluate(ws,session,"chrome.runtime.sendMessage({type:'GET_STATS'})");active=witness(ws,new_id)
        observations['upgradeWorker']=active
        check('same-path upgrade retains identity',old_id==new_id)
        check('upgrade activates actual new worker code',active.get('version')=='3.7.7' and active.get('localeMigration') and active.get('catalog'))
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
