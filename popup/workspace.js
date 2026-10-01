/* Shared shell for the action popup and the full settings page.
   This module owns navigation presentation only; settings remain in popup.js. */
'use strict';
(() => {
  const G=globalThis.GXT;
  const dedicated=new URLSearchParams(location.search).get('surface')==='settings';
  document.body.classList.toggle('settings-surface',dedicated);
  document.body.dataset.surface=dedicated?'settings':'popup';
  function mount({navigate,openAppearance}) {
    const rail=document.getElementById('settingsRail');
    if(dedicated&&rail){
      rail.hidden=false;
      for(const group of document.querySelectorAll('#view-settings .nav-group')){
        const section=document.createElement('div');section.className='nav-group';
        section.append(group.querySelector('.group-lbl').cloneNode(true));
        for(const original of group.querySelectorAll('.nav-row')){
          const button=document.createElement('button');button.type='button';button.className='rail-row';
          if(original.dataset.goto)button.dataset.goto=original.dataset.goto;
          for(const selector of ['.nav-ico','.nav-title']){const part=original.querySelector(selector);if(part)button.append(part.cloneNode(true));}
          if(original.dataset.goto)button.addEventListener('click',()=>navigate(original.dataset.goto,button));
          else button.addEventListener('click',()=>original.dataset.sheet?openAppearance():original.click());
          section.append(button);
        }
        rail.append(section);
      }
    }
    for(const button of document.querySelectorAll('[data-goto]:not(.nav-row):not(.rail-row)'))
      button.addEventListener('click',()=>navigate(button.dataset.goto,button));
    document.querySelector('[data-open-workshop]')?.addEventListener('click',()=>document.getElementById('openSubtitles').click());
    document.getElementById('openSettingsPage')?.addEventListener('click',async()=>{
      const button=document.getElementById('openSettingsPage');button.disabled=true;
      try{
        if(chrome.runtime.openOptionsPage)await chrome.runtime.openOptionsPage();
        else if(chrome.tabs?.create)await chrome.tabs.create({url:chrome.runtime.getURL('popup/popup.html')+'?surface=settings'});
        else window.open(chrome.runtime.getURL('popup/popup.html')+'?surface=settings','_blank','noopener');
      }catch{
        document.getElementById('quickProviderStatus').textContent=G.i18n.t('popup.openSettingsFailed');
      }finally{button.disabled=false;}
    });
    document.getElementById('footerVersion').textContent=chrome.runtime.getManifest?.().version||'';
    G.i18n.apply(rail||document);
  }
  function reflect(name){
    for(const button of document.querySelectorAll('.shell-tab,.rail-row[data-goto]')){
      const selected=button.classList.contains('shell-tab')?(button.dataset.goto==='home'?name==='home':name!=='home'):button.dataset.goto===name;
      if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    }
  }
  G.popupWorkspace={dedicated,mount,reflect};
})();
