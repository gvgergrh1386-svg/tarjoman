"""Installed MV3 visual/interaction audit; synthetic data, temporary profile.

Run with --extension . or an extracted release. Evidence is written under
.audit/3.8.2/ui by default. Provider and speech calls belong to existing suites.
"""
import argparse,base64,json,subprocess,sys,tempfile,time,traceback
from pathlib import Path
import run_harness as H

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--extension',type=Path,default=H.ROOT)
parser.add_argument('--output',type=Path,default=H.ROOT/'.audit/3.8.2/ui')
args=parser.parse_args();args.output.mkdir(parents=True,exist_ok=True)
checks=[];evidence={}
def check(name,value):
    checks.append({'name':name,'ok':bool(value)})
    print(('PASS ' if value else 'FAIL ')+name,flush=True)

with tempfile.TemporaryDirectory(prefix='tarjoman-ui-382-') as directory:
  port=H.free_port()
  proc=subprocess.Popen([str(H.find_chrome()),f'--user-data-dir={directory}',f'--remote-debugging-port={port}',
      '--enable-unsafe-extension-debugging','--headless=new','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--disable-sync','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','about:blank'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  ws=None
  try:
    for _ in range(100):
      try:ws=H.cdp.WS(H.cdp.browser_ws(port));break
      except OSError:time.sleep(.1)
    if not ws:raise RuntimeError('Chrome did not start')
    ident=ws.call('Extensions.loadUnpacked',{'path':str(args.extension.resolve())})['id']
    evidence['browser']=ws.call('Browser.getVersion')
    targets={}
    def ev(s,expression):
      if s in targets:ws.call('Target.activateTarget',{'targetId':targets[s]})
      result=ws.call('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True},session=s)
      if result.get('exceptionDetails'):raise RuntimeError(json.dumps(result['exceptionDetails']))
      return result.get('result',{}).get('value')
    def until(s,expression):
      return ev(s,"(async()=>{for(let i=0;i<100;i++){if(await ("+expression+"))return true;await new Promise(r=>setTimeout(r,50));}return false;})()")
    def size(s,w,h=820):
      ws.call('Emulation.setDeviceMetricsOverride',{'width':w,'height':h,'deviceScaleFactor':1,'mobile':False},session=s)
    def page(path,w,h=820):
      t=ws.call('Target.createTarget',{'url':'about:blank'})['targetId']
      s=ws.call('Target.attachToTarget',{'targetId':t,'flatten':True})['sessionId']
      targets[s]=t
      ws.call('Runtime.enable',session=s);ws.call('Page.enable',session=s);size(s,w,h)
      ws.call('Page.navigate',{'url':f'chrome-extension://{ident}/{path}'},session=s)
      if not until(s,"document.readyState==='complete'&&!!globalThis.GXT?.getSettings"):raise RuntimeError('Page not initialized: '+path)
      return s
    def shot(s,name):
      ev(s,"Promise.race([document.fonts.ready.then(()=>Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>null)))),new Promise(r=>setTimeout(r,700))])")
      data=ws.call('Page.captureScreenshot',{'format':'png'},session=s)['data']
      (args.output/(name+'.png')).write_bytes(base64.b64decode(data))
    def no_overflow(s):return ev(s,"document.documentElement.scrollWidth<=innerWidth+1&&[...document.querySelectorAll('.view.active')].every(e=>e.scrollWidth<=e.clientWidth+1)")
    popup=page('popup/popup.html',400,600)
    check('extension version is 3.8.2',ev(popup,"chrome.runtime.getManifest().version==='3.8.2'"))
    check('options page uses the existing shell without new permissions',ev(popup,"chrome.runtime.getManifest().options_ui.page==='popup/popup.html?surface=settings'&&!chrome.runtime.getManifest().permissions.includes('sidePanel')"))
    for language in ['fa','en']:
      for theme in ['daylight','graphite']:
        ev(popup,f"GXT.setSettings({{uiLanguage:'{language}',uiTheme:'{theme}',uiMotion:'reduce'}}).then(()=>true)")
        check(language+' '+theme+' live language/theme',until(popup,f"document.documentElement.lang==='{language}'&&document.documentElement.dataset.theme==='{theme}'"))
        ev(popup,"document.querySelector('#navBack').click();document.querySelector('#searchClear').click();true")
        check(language+' '+theme+' popup fits 400px',no_overflow(popup))
        check(language+' '+theme+' new identity uses a solid surface',ev(popup,"getComputedStyle(document.documentElement).getPropertyValue('--gxt-card-alpha').trim()==='100%'"))
        shot(popup,f'{language}-{theme}-popup')
        nav=ev(popup,"[...document.querySelectorAll('.nav-row[data-goto]')].map(e=>e.dataset.goto)")
        check(language+' '+theme+' every destination fits popup',all(ev(popup,"(()=>{document.querySelector('.nav-row[data-goto='+"+json.dumps(n)+"+']').click();const el=document.querySelector('.view.active');return !!el&&el.scrollWidth<=el.clientWidth+1;})()") for n in nav))
        ev(popup,"document.querySelector('#navBack').click();document.querySelector('#appearanceBtn').focus();document.querySelector('#appearanceBtn').click();true")
        check(language+' '+theme+' dialog focus and background isolation',ev(popup,"!document.querySelector('#sheet').classList.contains('hidden')&&document.querySelector('main').inert&&document.activeElement.id==='sheetClose'"))
        shot(popup,f'{language}-{theme}-appearance')
        ws.call('Input.dispatchKeyEvent',{'type':'keyDown','key':'Escape','code':'Escape','windowsVirtualKeyCode':27},session=popup)
        ws.call('Input.dispatchKeyEvent',{'type':'keyUp','key':'Escape','code':'Escape','windowsVirtualKeyCode':27},session=popup)
        check(language+' '+theme+' Escape restores focus',ev(popup,"document.activeElement.id==='appearanceBtn'&&!document.querySelector('main').inert"))
        settings=page('popup/popup.html?surface=settings',1280)
        check(language+' '+theme+' dedicated settings initialized',until(settings,"!!document.querySelector('#sumEngine')?.textContent.trim()&&document.querySelector('#sumEngine').textContent.trim()!=='—'"))
        check(language+' '+theme+' desktop settings fits',no_overflow(settings))
        shot(settings,f'{language}-{theme}-settings')
        ev(settings,"document.querySelector('.nav-row[data-goto=engine]').click();true")
        check(language+' '+theme+' engine controls present and labeled',ev(settings,"!!document.querySelector('#provider')&&!!document.querySelector('#provider').labels?.length"))
        shot(settings,f'{language}-{theme}-engine')
        size(settings,375)
        check(language+' '+theme+' settings reflow to 375px',no_overflow(settings))
        work=page('pages/subtitles.html',1280)
        check(language+' '+theme+' workshop ready',until(work,"!!document.querySelector('#picker')&&!document.querySelector('#picker').disabled"))
        check(language+' '+theme+' workshop empty state fits',no_overflow(work))
        shot(work,f'{language}-{theme}-workshop-empty')
        fixture=Path(directory)/f'{language}-{theme}.srt'
        fixture.write_text('1\n00:00:01,000 --> 00:00:03,000\nA short caption.\n\n2\n00:00:04,000 --> 00:00:08,000\nNASA / مثال فارسی / https://example.com — '+('A longer line of text. '*18)+'\n',encoding='utf8')
        root=ws.call('DOM.getDocument',session=work)['root']['nodeId']
        node=ws.call('DOM.querySelector',{'nodeId':root,'selector':'#picker'},session=work)['nodeId']
        ws.call('DOM.setFileInputFiles',{'nodeId':node,'files':[str(fixture)]},session=work)
        check(language+' '+theme+' real SRT import mounts editable cues',until(work,"document.querySelectorAll('#editorRows [data-action=edit]').length===2"))
        check(language+' '+theme+' mixed/long source text does not overflow',no_overflow(work))
        check(language+' '+theme+' manual translation persists with lock',ev(work,"(()=>{const e=document.querySelector('#editorRows [data-action=edit]');e.value='ویرایش دستی / Manual translation / NASA';e.dispatchEvent(new Event('input',{bubbles:true}));e.blur();return !!document.querySelector('#editorRows [data-action=lock]').checked;})()"))
        check(language+' '+theme+' manual edit saved',until(work,"/saved|ذخیره شد/i.test(document.querySelector('#saveStatus').textContent)"))
        ev(work,"scrollTo(0,0);true");shot(work,f'{language}-{theme}-workshop-editor')
        size(work,375)
        check(language+' '+theme+' workshop reflows to 375px',no_overflow(work))
        shot(work,f'{language}-{theme}-workshop-mobile')
    ev(popup,"GXT.setSettings({uiDensity:'large',uiTextScale:1.3,uiLanguage:'fa'}).then(()=>true)")
    size(popup,440,600)
    check('large Persian typography fits popup',until(popup,"document.documentElement.dataset.density==='large'") and no_overflow(popup))
    shot(popup,'fa-large-popup')
    errors=[e['params'].get('exceptionDetails',{}).get('text','exception') for e in ws.events if e.get('method')=='Runtime.exceptionThrown']
    evidence['exceptions']=errors
    check('no uncaught browser exceptions',not errors)
  except Exception as error:
    check('audit completed',False);evidence['exception']=traceback.format_exc();print(evidence['exception'],flush=True)
  finally:
    if ws:
      try:ws.call('Browser.close')
      except (OSError,RuntimeError):pass
      ws.close()
    try:proc.wait(timeout=10)
    except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
(args.output/'results.json').write_text(json.dumps({'checks':checks,'evidence':evidence},ensure_ascii=False,indent=2),encoding='utf8')
sys.exit(any(not c['ok'] for c in checks))
