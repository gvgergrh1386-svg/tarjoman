/* Workspace navigation follows the existing file/translation lifecycle.
   It never owns project data, requests, cancellation or save state. */
'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const steps=[...document.querySelectorAll('[data-workshop-step]')];
  const visible=id=>!!$(id)&&!$(id).classList.contains('hidden');
  let hadProject=false,active='drop';
  function reflect(){
    for(const button of steps){
      const current=button.dataset.workshopStep===active;
      button.classList.toggle('is-active',current);
      if(current)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
    }
  }
  function sync(){
    const loaded=visible('fileCard');
    document.body.classList.toggle('has-project',loaded);
    for(const button of steps)button.disabled=!visible(button.dataset.workshopStep);
    if(loaded!==hadProject){
      $('projectLibrary').open=!loaded;
      active=loaded?'optionsCard':'drop';
      hadProject=loaded;
    }
    if(!visible(active))active=loaded?'editorCard':'drop';
    $('editorRows').setAttribute('aria-busy',String(visible('progress')));
    for(const id of ['progressFill','dubFill']){
      const fill=$(id),value=Math.max(0,Math.min(100,parseFloat(fill.style.width)||0));
      fill.parentElement.setAttribute('aria-valuenow',String(value));
    }
    reflect();
  }
  for(const button of steps)button.addEventListener('click',()=>{
    const target=$(button.dataset.workshopStep);if(!target||button.disabled)return;
    active=target.id;reflect();
    if(!target.hasAttribute('tabindex'))target.tabIndex=-1;
    target.scrollIntoView({block:'start',behavior:'auto'});target.focus({preventScroll:true});
  });
  const observer=new MutationObserver(sync);
  for(const id of ['fileCard','optionsCard','editorCard','resultCard','progress'])observer.observe($(id),{attributes:true,attributeFilter:['class']});
  for(const id of ['progressFill','dubFill'])observer.observe($(id),{attributes:true,attributeFilter:['style']});
  addEventListener('pagehide',()=>observer.disconnect(),{once:true});
  sync();
})();
