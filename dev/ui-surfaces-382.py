"""Browser visual audit of the production injected UI, with synthetic fixtures."""
import base64,json,time
from pathlib import Path
import run_harness as H

out=H.ROOT/'.audit/3.8.2/surfaces';out.mkdir(parents=True,exist_ok=True)
checks=[]
def check(name,value):
    checks.append({'name':name,'ok':bool(value)})
    print(('PASS ' if value else 'FAIL ')+name,flush=True)

with H.serve() as (port,ws,proc):
  def page(name,ready):
    target=ws.call('Target.createTarget',{'url':'about:blank'})['targetId']
    session=ws.call('Target.attachToTarget',{'targetId':target,'flatten':True})['sessionId']
    ws.call('Runtime.enable',session=session);ws.call('Page.enable',session=session)
    ws.call('Emulation.setEmulatedMedia',{'features':[{'name':'prefers-reduced-transparency','value':'no-preference'},{'name':'forced-colors','value':'none'}]},session=session)
    ws.call('Page.addScriptToEvaluateOnNewDocument',{'source':"Object.defineProperty(navigator,'languages',{get:()=>['fa-IR']});"},session=session)
    ws.call('Emulation.setDeviceMetricsOverride',{'width':1280,'height':880,'deviceScaleFactor':1,'mobile':False},session=session)
    ws.call('Page.navigate',{'url':f'http://127.0.0.1:{port}/dev/{name}.html'},session=session)
    for _ in range(160):
      if ev(session,ready):return session
      time.sleep(.1)
    raise RuntimeError('Fixture did not become ready: '+name)
  def ev(session,expression):
    result=ws.call('Runtime.evaluate',{'expression':expression,'returnByValue':True,'awaitPromise':True},session=session)
    if result.get('exceptionDetails'):raise RuntimeError(json.dumps(result['exceptionDetails']))
    return result.get('result',{}).get('value')
  def settle(session):ev(session,"new Promise(r=>setTimeout(r,150))")
  def shot(session,name):
    ev(session,"document.fonts.ready.then(()=>{for(const e of document.querySelectorAll('#summary,#probe'))e.hidden=true;return true;})")
    (out/(name+'.png')).write_bytes(base64.b64decode(ws.call('Page.captureScreenshot',{'format':'png'},session=session)['data']))

  yt=page('player-preview','globalThis.__previewReady===true')
  ev(yt,"globalThis.Q=s=>GXT.youtube.__root().querySelector(s);true")
  for lang in ['fa','en']:
    for theme in ['graphite','daylight']:
      ev(yt,f"GXT.setSettings({{uiLanguage:'{lang}',uiTheme:'{theme}',uiMotion:'reduce',uiVideoStyle:'glass'}}).then(()=>true)")
      settle(yt)
      check(lang+' '+theme+' glass dock stays video safe',ev(yt,"getComputedStyle(Q('.yt-controls')).backgroundColor==='rgba(18, 20, 22, 0.66)'&&getComputedStyle(Q('.yt-controls')).backdropFilter==='none'"))
      check(lang+' '+theme+' controls use vector glyphs',ev(yt,"['#gxt-yt-gear','#gxt-yt-dub'].every(s=>getComputedStyle(Q(s),'::after').maskImage!=='none')"))
      ev(yt,"Q('#gxt-yt-tab-caption').click();true")
      check(lang+' '+theme+' target and model fields are themed and bounded',ev(yt,"[...Q('.yt-panel').querySelectorAll('input[type=text]')].every(e=>getComputedStyle(e).backgroundColor!=='rgb(255, 255, 255)'&&e.getBoundingClientRect().right<=Q('.yt-panel').getBoundingClientRect().right+1)"))
      shot(yt,lang+'-'+theme+'-youtube-caption')
      ev(yt,"Q('#gxt-yt-tab-look').click();Q('#gxt-yt-tab-look').focus();Q('#gxt-yt-tab-look').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));true")
      check(lang+' '+theme+' tab keyboard navigation and relationships work',ev(yt,"Q('#gxt-yt-tab-caption').getAttribute('aria-selected')==='true'&&Q('#gxt-yt-pane-caption').getAttribute('aria-labelledby')==='gxt-yt-tab-caption'"))
      for style in ['solid','inherit','glass']:
        ev(yt,"(()=>{Q('#gxt-yt-tab-look').click();const s=Q('[data-setting=uiVideoStyle]');s.focus();s.value="+json.dumps(style)+";s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()")
        settle(yt)
        check(lang+' '+theme+' '+style+' repaints, persists and keeps focus',ev(yt,"GXT.getSettings().then(s=>{const c=getComputedStyle(Q('.yt-controls')),p=getComputedStyle(Q('.yt-panel'));return s.uiVideoStyle==="+json.dumps(style)+"&&GXT.youtube.__root().activeElement?.dataset.setting==='uiVideoStyle'&&Q('#gxt-yt-tab-look').getAttribute('aria-selected')==='true'&&(s.uiVideoStyle==='glass'?c.backgroundColor==='rgba(18, 20, 22, 0.66)'&&p.getPropertyValue('--gxt-card-alpha').trim()==='84%':s.uiVideoStyle==='solid'?c.backgroundColor==='rgb(18, 20, 22)'&&p.getPropertyValue('--gxt-card-alpha').trim()==='100%':p.getPropertyValue('--gxt-bg').trim()===(s.uiTheme==='daylight'?'#f3f5f3':'#101716'));})"))
      shot(yt,lang+'-'+theme+'-youtube-look')
  ev(yt,"document.querySelector('#movie_player').style.width='360px';document.querySelector('#movie_player').style.height='640px';true")
  settle(yt)
  check('small player contains its settings panel',ev(yt,"(()=>{const p=Q('.yt-panel').getBoundingClientRect(),v=document.querySelector('#movie_player').getBoundingClientRect();return p.left>=v.left&&p.right<=v.right+1&&p.top>=v.top;})()"))
  shot(yt,'youtube-narrow')
  ws.call('Emulation.setEmulatedMedia',{'features':[{'name':'prefers-reduced-transparency','value':'reduce'}]},session=yt)
  ev(yt,"GXT.setSettings({cardOpaque:true,uiSurface:'solid'}).then(()=>true)");settle(yt)
  check('explicit glass survives system reduction and opaque reading cards',ev(yt,"getComputedStyle(Q('.yt-controls')).backgroundColor==='rgba(18, 20, 22, 0.66)'&&getComputedStyle(Q('.yt-panel')).getPropertyValue('--gxt-card-alpha').trim()==='84%'"))
  ev(yt,"Q('#gxt-yt-tab-look').click();Q('[data-setting=videoSafeUi]').focus();Q('[data-setting=videoSafeUi]').click();true");settle(yt)
  check('glass blur switch changes both surfaces and preserves focus',ev(yt,"getComputedStyle(Q('.yt-controls')).backdropFilter.includes('blur(16px)')&&getComputedStyle(Q('.yt-panel')).backdropFilter.includes('blur(16px)')&&GXT.youtube.__root().activeElement?.dataset.setting==='videoSafeUi'"))
  ev(yt,"document.querySelector('#movie_player').classList.add('ytp-autohide');true");settle(yt)
  check('open settings stay reachable when native controls hide',ev(yt,"getComputedStyle(Q('.yt-panel')).visibility==='visible'&&getComputedStyle(Q('.yt-controls')).visibility==='visible'"))
  ev(yt,"GXT.setSettings({uiVideoStyle:'inherit',uiSurface:'glass',uiOpacity:84,cardOpaque:false}).then(()=>true)");settle(yt)
  check('inherited player surfaces respect system transparency reduction',ev(yt,"getComputedStyle(Q('.yt-panel')).backgroundColor===getComputedStyle(Q('.yt-tabs')).backgroundColor&&getComputedStyle(Q('.yt-panel')).backdropFilter==='none'"))
  ev(yt,"GXT.setSettings({uiVideoStyle:'glass',videoSafeUi:true}).then(()=>true)");settle(yt)
  ws.call('Emulation.setEmulatedMedia',{'features':[{'name':'forced-colors','value':'active'}]},session=yt)
  ev(yt,"Q('#gxt-yt-gear').focus();true")
  check('forced colors retain a visible dock focus outline',ev(yt,"getComputedStyle(Q('#gxt-yt-gear')).outlineStyle!=='none'&&parseFloat(getComputedStyle(Q('#gxt-yt-gear')).outlineWidth)>=2"))

  content=page('mock-page',"!!globalThis.GXT?.ui&&!!document.querySelector('#summary')?.textContent.includes('checks passed')")
  sample='ترجمه باید خوانا و روان باشد.\n\nمتن فارسی در کنار NASA و یک نشانی مانند example.com باید بدون به‌هم‌ریختگی نمایش داده شود.\n\nاین کادر از همان رنگ‌ها، قلم و کنترل‌های ترجمان استفاده می‌کند.'
  ev(content,"GXT.ui.configure({...GXT.DEFAULTS,uiLanguage:'fa',uiTheme:'daylight'});globalThis.demo=GXT.ui.card({title:'ترجمهٔ متن انتخاب‌شده',anchorPoint:{x:500,y:190}});demo.body.textContent="+json.dumps(sample)+";true")
  shot(content,'fa-daylight-selection')
  check('shared card close control has an accessible name',ev(content,"!!demo.head.querySelector('button[aria-label]')&&[...demo.head.querySelectorAll('button')].filter(e=>e.textContent==='✕').every(e=>!!e.getAttribute('aria-label'))"))
  manga=page('mock-manga',"!!document.querySelector('#summary')?.textContent.includes('checks passed')")
  shot(manga,'fa-manga-stopped')
  x=page('mock-x',"!!document.querySelector('#summary')?.textContent.includes('checks passed')")
  shot(x,'fa-x')
(out/'results.json').write_text(json.dumps(checks,indent=2),encoding='utf8')
raise SystemExit(any(not c['ok'] for c in checks))
