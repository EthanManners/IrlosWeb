/* the backpack schematic, ported from reference/backpack-3d.html.
   Differences from the prototype:
   - three.js comes from /vendor/three.min.js, same origin
   - the drop starts the first time the stage scrolls into view, once
   - the fallback <dl> is generated from the same PARTS data as the labels
   - no WebGL means no stage, and the <dl> carries the page */
(function(){
  var stage=document.getElementById('stage');
  if(!stage) return;

  var ACCENT=0x00d4ff, DIMC=0x0a6f85, LIVE=0x4ade80, SHELL=0x2e2e31;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── components as data. Geometry, positions and explode vectors are an
     invented layout and must be corrected against the real build before
     launch (see README open items). dt/dd feed the fallback <dl>. ── */
  var PARTS=[
    { id:'pi', title:'Orange Pi 5 Plus', desc:'Runs IRLOS. Encodes 1080p60 in hardware, so the CPU stays free for everything else.',
      spec:[['soc','RK3588'],['ram','16GB'],['encode','h264 / hevc']],
      dt:'compute', dd:'Orange Pi 5 Plus. Rockchip RK3588, 16GB RAM. Hardware h264 encode at 1080p60.',
      geo:[1.55,0.10,1.05], pos:[0,0.62,-0.05], op:0.26, explode:[0,1.5,1.1], side:'r', lead:[1.05,0.08,0] },
    { id:'bat', title:'25,000mAh battery', desc:'USB-C PD at 65W. Swap it mid-stream and the feed keeps running off the buffer.',
      spec:[['out','65W PD'],['cells','certified'],['swap','hot']],
      dt:'power', dd:'25,000mAh USB-C PD battery, 65W. Swappable mid-stream without dropping the feed.',
      geo:[1.70,0.72,0.85], pos:[0,-0.62,-0.05], op:0.19, explode:[0,-1.5,1.2], side:'l', lead:[-1.15,-0.05,0] },
    { id:'modem', title:'4G modem', desc:'Single SIM, any carrier. The second USB port takes another modem if you want bonding later.',
      spec:[['sim','1x nano'],['spare','1x usb'],['bond','supported']],
      dt:'modem', dd:'Internal 4G modem, single SIM, any carrier. A second USB port stays free for another modem.',
      geo:[0.62,0.09,0.52], pos:[-0.62,0.20,-0.05], op:0.24, explode:[-1.6,0.3,0.9], side:'l', lead:[-0.55,0.08,0] },
    { id:'ssd', title:'NVMe SSD', desc:'Records locally at full bitrate while you stream, so a dropped connection never costs you the footage.',
      spec:[['bus','pcie'],['use','local rec']],
      dt:'storage', dd:'NVMe SSD. Records locally at full bitrate while the stream runs.',
      geo:[0.52,0.06,0.34], pos:[0.62,0.20,-0.05], op:0.24, explode:[1.6,0.3,0.9], side:'r', lead:[0.5,0.08,0] }
  ];
  var ANT={ id:'ant', title:'Antennas', desc:'Two externals routed up the straps. Keeps the radio out of the bag and off your back.',
            spec:[['count','2x'],['route','strap']],
            dt:'antennas', dd:'Two external antennas routed up the shoulder straps.',
            side:'r', lead:[0.16,0.5,0] };
  var BTNPART={ id:'btn', title:'STREAM button', desc:'One press goes live, one press stops. It is the only control you need while you are out.',
            spec:[['gpio','17'],['action','start / stop']],
            dt:'control', dd:'STREAM button on the left strap. One press starts, one press stops.',
            side:'l', lead:[-0.3,0.16,-0.16] };

  /* the fallback <dl> and the 3D labels come from the same data, so they
     cannot drift. The static markup is only a no-JS fallback. */
  var dlEl=document.getElementById('bagDl');
  if(dlEl){
    dlEl.innerHTML=[PARTS[0],PARTS[1],PARTS[2],ANT,PARTS[3],BTNPART].map(function(p){
      return '<div><dt>'+p.dt+'</dt><dd>'+p.dd+'</dd></div>';
    }).join('');
  }

  var cv=document.getElementById('scene');
  var renderer;
  try{
    if(!window.THREE) throw new Error('three.js missing');
    renderer=new THREE.WebGLRenderer({canvas:cv,antialias:true,alpha:true});
  }catch(err){
    /* no WebGL: the <dl> below the stage is the whole page */
    stage.hidden=true;
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));

  var labelLayer=document.getElementById('labels'), hint=document.getElementById('hint');
  var readout=document.getElementById('readout');
  var rid=document.getElementById('rid'), rtitle=document.getElementById('rtitle');
  var rdesc=document.getElementById('rdesc'), rspec=document.getElementById('rspec');

  var scene=new THREE.Scene();
  var camera=new THREE.PerspectiveCamera(38,1,0.1,200);
  var camTarget=new THREE.Vector3(0,0.05,0);

  scene.add(new THREE.AmbientLight(0xffffff,0.5));
  var key=new THREE.DirectionalLight(0xa8ecff,0.85); key.position.set(4,6,5); scene.add(key);
  var rim=new THREE.DirectionalLight(ACCENT,0.55); rim.position.set(-5,1.5,-4); scene.add(rim);
  var under=new THREE.DirectionalLight(ACCENT,0.18); under.position.set(0,-4,2); scene.add(under);

  var root=new THREE.Group(); scene.add(root);
  var body=new THREE.Group(); root.add(body);

  var W=2.5,H=3.2,D=1.35;

  // ── floor grid + contact shadow, so the bag sits somewhere ──
  var grid=new THREE.GridHelper(16,32,DIMC,0x141618);
  grid.position.y=-H/2-0.62;
  grid.material.transparent=true; grid.material.opacity=0.16;
  scene.add(grid);

  var shadow=new THREE.Mesh(
    new THREE.CircleGeometry(1.75,40),
    new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.42})
  );
  shadow.rotation.x=-Math.PI/2; shadow.position.y=-H/2-0.6; scene.add(shadow);

  // ── builders ────────────────────────────────────────────────
  function edged(geo,color,op,lineOp){
    var g=new THREE.Group();
    var fillMat=new THREE.MeshStandardMaterial({
      color:color,transparent:true,opacity:op,roughness:0.8,metalness:0.08,
      depthWrite:false,side:THREE.DoubleSide
    });
    var fill=new THREE.Mesh(geo,fillMat);
    var lineMat=new THREE.LineBasicMaterial({color:color,transparent:true,opacity:lineOp===undefined?0.85:lineOp});
    var line=new THREE.LineSegments(new THREE.EdgesGeometry(geo),lineMat);
    g.add(fill); g.add(line);
    g.userData.mats=[fillMat,lineMat];
    g.userData.base=[op,lineOp===undefined?0.85:lineOp];
    g.userData.fill=fill;
    fill.userData.owner=g;
    return g;
  }
  function fade(g,k){
    var m=g.userData.mats,b=g.userData.base;
    if(!m)return;
    m[0].opacity=b[0]*k; m[1].opacity=b[1]*k;
    g.visible=k>0.004;
  }
  function glow(g,k){ // 0 rest, 1 highlighted
    var m=g.userData.mats,b=g.userData.base;
    if(!m||!g.userData.vis)return;
    m[0].opacity=b[0]*g.userData.vis*(1+k*1.5);
    m[1].opacity=Math.min(1,b[1]*g.userData.vis*(1+k*0.6));
    if(m[0].emissive){ m[0].emissive.setHex(ACCENT); m[0].emissiveIntensity=k*0.5; }
  }

  // ── shell ───────────────────────────────────────────────────
  var back=edged(new THREE.BoxGeometry(W,H,0.10),SHELL,0.18,0.55); back.position.z=-D/2; body.add(back);
  var sideL=edged(new THREE.BoxGeometry(0.10,H,D),SHELL,0.15,0.5); sideL.position.x=-W/2; body.add(sideL);
  var sideR=edged(new THREE.BoxGeometry(0.10,H,D),SHELL,0.15,0.5); sideR.position.x=W/2; body.add(sideR);
  var bot=edged(new THREE.BoxGeometry(W,0.10,D),SHELL,0.15,0.5); bot.position.y=-H/2; body.add(bot);
  var lid=edged(new THREE.BoxGeometry(W,0.10,D),SHELL,0.15,0.5); lid.position.y=H/2; body.add(lid);

  var hinge=new THREE.Group(); hinge.position.set(0,-H/2,D/2); body.add(hinge);
  var flap=edged(new THREE.BoxGeometry(W,H,0.10),SHELL,0.20,0.6);
  flap.position.set(0,H/2,0); hinge.add(flap);

  function strap(x){
    var s=edged(new THREE.BoxGeometry(0.30,H*0.92,0.16),SHELL,0.13,0.42);
    s.position.set(x,0.05,-D/2-0.22); body.add(s); return s;
  }
  strap(-0.72); strap(0.72);

  // ── internals, from the PARTS data ──────────────────────────
  var guts=new THREE.Group(); body.add(guts);

  PARTS.forEach(function(P){
    var g=edged(new THREE.BoxGeometry(P.geo[0],P.geo[1],P.geo[2]),ACCENT,P.op,0.9);
    g.position.set(P.pos[0],P.pos[1],P.pos[2]);
    g.userData.home=g.position.clone();
    g.userData.part=P;
    g.userData.vis=0;
    guts.add(g);
    P.obj=g;
  });

  // antennas
  function antenna(x,flipSign){
    var g=new THREE.Group();
    var m=new THREE.Mesh(new THREE.CylinderGeometry(0.035,0.035,1.15,10),
      new THREE.MeshStandardMaterial({color:ACCENT,transparent:true,opacity:0.5,
        roughness:0.5,emissive:DIMC,emissiveIntensity:0.4,depthWrite:false}));
    g.add(m);
    var tip=new THREE.Mesh(new THREE.SphereGeometry(0.055,10,8),
      new THREE.MeshStandardMaterial({color:ACCENT,transparent:true,opacity:0.7,emissive:ACCENT,emissiveIntensity:0.5,depthWrite:false}));
    tip.position.y=0.6; g.add(tip);
    g.position.set(x,1.30,-D/2-0.05);
    g.rotation.z=flipSign*0.17;
    g.userData.mats=[m.material,tip.material];
    g.userData.base=[0.5,0.7];
    g.userData.fill=m; m.userData.owner=g;
    g.userData.vis=0;
    guts.add(g);
    return g;
  }
  var antL=antenna(-0.72,0.17), antR=antenna(0.72,-0.17);
  ANT.obj=antR;
  antL.userData.part=ANT; antR.userData.part=ANT;

  // STREAM button on the strap
  var btnMat=new THREE.MeshStandardMaterial({color:LIVE,emissive:LIVE,emissiveIntensity:0.5,
    transparent:true,opacity:0.95,roughness:0.35});
  var btnMesh=new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.09,24),btnMat);
  btnMesh.rotation.x=Math.PI/2;
  var btn=new THREE.Group(); btn.add(btnMesh);
  btn.position.set(-0.72,0.85,-D/2-0.32);
  btn.userData.mats=[btnMat,btnMat]; btn.userData.base=[0.95,0.95];
  btn.userData.fill=btnMesh; btnMesh.userData.owner=btn;
  btn.userData.vis=1;
  BTNPART.obj=btn;
  btn.userData.part=BTNPART;
  body.add(btn);

  // cable routing, cheap curves that read as a real build
  function cable(a,b,bow){
    var pts=[];
    var curve=new THREE.QuadraticBezierCurve3(
      new THREE.Vector3(a[0],a[1],a[2]),
      new THREE.Vector3((a[0]+b[0])/2+bow,(a[1]+b[1])/2,(a[2]+b[2])/2+0.22),
      new THREE.Vector3(b[0],b[1],b[2])
    );
    pts=curve.getPoints(22);
    var geo=new THREE.BufferGeometry().setFromPoints(pts);
    var mat=new THREE.LineBasicMaterial({color:DIMC,transparent:true,opacity:0.7});
    var l=new THREE.Line(geo,mat);
    l.userData.mats=[mat,mat]; l.userData.base=[0.7,0.7]; l.userData.vis=0;
    guts.add(l); return l;
  }
  var cables=[
    cable([0,0.57,-0.05],[0,-0.28,-0.05],0.42),
    cable([-0.5,0.62,-0.05],[-0.62,0.24,-0.05],-0.2),
    cable([0.5,0.62,-0.05],[0.62,0.23,-0.05],0.2),
    cable([-0.72,1.05,-0.7],[-0.62,0.24,-0.05],-0.35),
    cable([0.72,1.05,-0.7],[-0.55,0.24,-0.05],0.35)
  ];

  var revealables=PARTS.map(function(P){return P.obj;}).concat([antL,antR],cables);
  revealables.forEach(function(g){ g.userData.vis=0; fade(g,0); });

  // hit targets for raycasting
  var HITS=[];
  PARTS.forEach(function(P){ HITS.push(P.obj.userData.fill); });
  HITS.push(antL.userData.fill, antR.userData.fill, btn.userData.fill);

  // ── labels ──────────────────────────────────────────────────
  var LABELS=PARTS.map(function(P){
    return {part:P, obj:P.obj, side:P.side, lead:P.lead};
  }).concat([
    {part:ANT, obj:antR, side:'r', lead:ANT.lead},
    {part:BTNPART, obj:btn, side:'l', lead:BTNPART.lead}
  ]);

  LABELS.forEach(function(L){
    var el=document.createElement('div');
    el.className='lbl'+(L.side==='l'?' flip':'');
    var bar='<i></i>';
    el.innerHTML=(L.side==='l'?'':bar)+'<b>'+L.part.title+'</b>'+(L.side==='l'?bar:'')+
                 '<s>'+L.part.spec[0][1]+'</s>';
    labelLayer.appendChild(el);
    L.el=el; L.v=new THREE.Vector3();
  });

  // ── state ───────────────────────────────────────────────────
  var t0=0, playing=false, opened=false, exploded=false, hot=null;
  var DROP=1150, HOLD=240, OPEN=1000;
  var drag={on:false,x:0,y:0,vel:0,spin:0,tilt:0};
  var explodeK=0, explodeTarget=0;
  var camDist=7.0, camDistTarget=7.0;

  function easeOutCubic(x){return 1-Math.pow(1-x,3);}
  function easeInOutCubic(x){return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2;}

  function setOpen(k){
    hinge.rotation.x=k*(Math.PI*0.66);
    flap.position.y=H/2-k*0.10;
    var vis=Math.max(0,(k-0.32)/0.68);
    revealables.forEach(function(g){ g.userData.vis=vis; fade(g,vis); });
    LABELS.forEach(function(L){ L.el.classList.toggle('on',k>0.7); });
    if(k<0.7) clearHot();
  }

  function showHot(part){
    if(hot===part)return;
    hot=part;
    rid.textContent=part.id;
    rtitle.textContent=part.title;
    rdesc.textContent=part.desc;
    rspec.innerHTML=part.spec.map(function(s){
      return '<dt>'+s[0]+'</dt><dd>'+s[1]+'</dd>';
    }).join('');
    readout.classList.add('on');
    LABELS.forEach(function(L){ L.el.classList.toggle('hot',L.part===part); });
  }
  function clearHot(){
    if(!hot)return;
    hot=null; readout.classList.remove('on');
    LABELS.forEach(function(L){ L.el.classList.remove('hot'); });
  }

  function play(){
    t0=performance.now(); playing=true; opened=true;
    hint.classList.remove('on');
    document.getElementById('toggle').textContent='close';
  }

  /* the prototype autoplays on load. Here the stage sits below the fold, so
     the drop waits for the first scroll into view (see the observer below).
     Reduced motion renders the bag already open, no drop, no idle spin. */
  var started=false;
  if(reduced){
    root.position.y=0; setOpen(1); opened=true; started=true; hint.classList.add('on');
  } else {
    setOpen(0); root.position.y=6.0;
  }

  // ── controls ────────────────────────────────────────────────
  document.getElementById('replay').addEventListener('click',function(){
    root.position.y=6.0; drag.spin=0; drag.tilt=0;
    exploded=false; explodeTarget=0;
    document.getElementById('explode').setAttribute('aria-pressed','false');
    setOpen(0); play();
  });
  document.getElementById('toggle').addEventListener('click',function(){
    opened=!opened; playing=false;
    setOpen(opened?1:0);
    this.textContent=opened?'close':'open';
    if(!opened){ exploded=false; explodeTarget=0;
      document.getElementById('explode').setAttribute('aria-pressed','false'); }
  });
  document.getElementById('explode').addEventListener('click',function(){
    if(!opened){ opened=true; playing=false; setOpen(1);
      document.getElementById('toggle').textContent='close'; }
    exploded=!exploded; explodeTarget=exploded?1:0;
    camDistTarget=exploded?8.4:7.0;
    this.setAttribute('aria-pressed',exploded?'true':'false');
  });

  // ── pointer ─────────────────────────────────────────────────
  var ray=new THREE.Raycaster(), ndc=new THREE.Vector2(), moved=false;

  function pick(cx,cy){
    var r=stage.getBoundingClientRect();
    ndc.x=((cx-r.left)/r.width)*2-1;
    ndc.y=-((cy-r.top)/r.height)*2+1;
    ray.setFromCamera(ndc,camera);
    var hits=ray.intersectObjects(HITS,false);
    for(var i=0;i<hits.length;i++){
      var owner=hits[i].object.userData.owner;
      if(owner && owner.userData.vis>0.5 && owner.userData.part) return owner.userData.part;
    }
    return null;
  }

  cv.addEventListener('mousedown',function(e){ drag.on=true; moved=false; drag.x=e.clientX; drag.y=e.clientY; cv.classList.add('grabbing'); });
  window.addEventListener('mouseup',function(){ drag.on=false; cv.classList.remove('grabbing'); });
  window.addEventListener('mousemove',function(e){
    if(drag.on){
      var dx=(e.clientX-drag.x)*0.008, dy=(e.clientY-drag.y)*0.004;
      if(Math.abs(e.clientX-drag.x)>2||Math.abs(e.clientY-drag.y)>2) moved=true;
      drag.spin+=dx; drag.vel=dx;
      drag.tilt=Math.max(-0.5,Math.min(0.55,drag.tilt+dy));
      drag.x=e.clientX; drag.y=e.clientY;
      return;
    }
    var r=stage.getBoundingClientRect();
    if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom){ clearHot(); return; }
    var p=pick(e.clientX,e.clientY);
    cv.classList.toggle('pointing',!!p);
    if(p) showHot(p); else clearHot();
  });

  cv.addEventListener('touchstart',function(e){
    drag.on=true; moved=false;
    drag.x=e.touches[0].clientX; drag.y=e.touches[0].clientY;
  },{passive:true});
  cv.addEventListener('touchmove',function(e){
    if(!drag.on)return;
    var dx=(e.touches[0].clientX-drag.x)*0.008, dy=(e.touches[0].clientY-drag.y)*0.004;
    if(Math.abs(dx)>0.004||Math.abs(dy)>0.004) moved=true;
    drag.spin+=dx; drag.vel=dx;
    drag.tilt=Math.max(-0.5,Math.min(0.55,drag.tilt+dy));
    drag.x=e.touches[0].clientX; drag.y=e.touches[0].clientY;
  },{passive:true});
  cv.addEventListener('touchend',function(e){
    drag.on=false;
    if(!moved && e.changedTouches[0]){
      var p=pick(e.changedTouches[0].clientX,e.changedTouches[0].clientY);
      if(p) showHot(p); else clearHot();
    }
  });

  // ── resize ──────────────────────────────────────────────────
  function resize(){
    var r=stage.getBoundingClientRect();
    renderer.setSize(r.width,r.height,false);
    camera.aspect=r.width/r.height;
    camera.fov=r.width<700?52:38;
    camera.updateProjectionMatrix();
  }
  resize();
  var rt; window.addEventListener('resize',function(){clearTimeout(rt);rt=setTimeout(resize,120);});

  // ── loop ────────────────────────────────────────────────────
  var running=true;
  new IntersectionObserver(function(es){
    es.forEach(function(e){
      running=e.isIntersecting;
      if(e.isIntersecting && !started){ started=true; play(); }
    });
  },{threshold:0.35}).observe(stage);
  document.addEventListener('visibilitychange',function(){running=!document.hidden;});

  var tmp=new THREE.Vector3();

  function tick(now){
    requestAnimationFrame(tick);
    if(!running)return;

    if(playing){
      var t=now-t0;
      if(t<DROP){
        var k=easeOutCubic(t/DROP);
        root.position.y=6.0*(1-k);
        root.rotation.x=(1-k)*-0.30;
        shadow.material.opacity=0.42*k*k;
        shadow.scale.setScalar(0.7+0.3*k);
      } else if(t<DROP+HOLD){
        root.position.y=0; root.rotation.x=0;
      } else if(t<DROP+HOLD+OPEN){
        setOpen(easeInOutCubic((t-DROP-HOLD)/OPEN));
      } else {
        setOpen(1); playing=false; hint.classList.add('on');
      }
    }

    // explode interpolation
    explodeK+=(explodeTarget-explodeK)*0.09;
    PARTS.forEach(function(P){
      var h=P.obj.userData.home;
      P.obj.position.set(
        h.x+P.explode[0]*explodeK,
        h.y+P.explode[1]*explodeK,
        h.z+P.explode[2]*explodeK
      );
    });
    cables.forEach(function(c){ fade(c, c.userData.vis*(1-explodeK)); });
    flap.rotation.z=0;

    // highlight
    revealables.concat([btn]).forEach(function(g){
      var isHot = hot && g.userData.part===hot;
      glow(g, isHot?1:0);
    });

    // spin + camera
    if(!drag.on){ drag.vel*=0.945; drag.spin+=drag.vel; }
    root.rotation.y=-0.45+drag.spin+((playing||reduced)?0:Math.sin(now*0.00015)*0.09);
    root.rotation.x=playing?root.rotation.x:drag.tilt*0.5;

    camDist+=(camDistTarget-camDist)*0.06;
    camera.position.set(0.62*camDist, 0.32*camDist, 0.90*camDist).multiplyScalar(1/1.14);
    camera.lookAt(camTarget);

    // project labels
    var r=stage.getBoundingClientRect();
    for(var i=0;i<LABELS.length;i++){
      var L=LABELS[i];
      tmp.set(L.lead[0],L.lead[1],L.lead[2]);
      L.obj.localToWorld(tmp);
      tmp.project(camera);
      L.el.style.left=((tmp.x*0.5+0.5)*r.width).toFixed(1)+'px';
      L.el.style.top=((-tmp.y*0.5+0.5)*r.height).toFixed(1)+'px';
      if(tmp.z>1) L.el.style.visibility='hidden'; else L.el.style.visibility='';
    }

    renderer.render(scene,camera);
  }
  requestAnimationFrame(tick);
})();
