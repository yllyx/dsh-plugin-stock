import{a5 as i,i as r,k as u,A as v}from"./Cb9D5NJ0.js";import{u as l}from"./wKnpmwzC.js";function m(){const t=i("device-is-mobile",()=>!1),n=i("device-is-tablet",()=>!1),o=i("device-is-desktop",()=>!1),s=i("device-is-touch",()=>!1),d=e=>{t.value=e<832,n.value=e>=832&&e<1e3,o.value=e>=1e3};l({script:[{key:"device-detect",children:`
          ;(function() {
            var width = window.innerWidth;
            window.__NUXT_DEVICE_WIDTH__ = width;
            document.documentElement.dataset.deviceWidth = width;
          })();
        `,tagPosition:"head"}]}),r(()=>{{const e=window.__NUXT_DEVICE_WIDTH__||window.innerWidth;d(e),s.value="ontouchstart"in window||navigator.maxTouchPoints>0;const a=()=>{d(window.innerWidth)};window.addEventListener("resize",a),u(()=>{window.removeEventListener("resize",a)})}});const c=v(()=>t.value?"mobile":n.value?"tablet":"desktop");return{isMobile:t,isTablet:n,isDesktop:o,isTouchDevice:s,deviceType:c}}export{m as u};
