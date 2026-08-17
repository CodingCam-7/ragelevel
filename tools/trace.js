// Ad-hoc tracer: drive one level with a competent bot and narrate what happens.
//   jsc trace.js -- <levelNumber> [variant]
var logs=[];var console={log:function(){},error:function(){},warn:function(){}};
var window={};var innerWidth=1200,innerHeight=800;function addEventListener(){}function setTimeout(){}
var performance={now:function(){return 0}};function requestAnimationFrame(){}
var fakeCtx=new Proxy({},{get:function(t,k){if(k==='canvas')return{};return function(){}},set:function(){return true}});
var document={getElementById:function(){return{getContext:function(){return fakeCtx},style:{}}}};
['core.js','font.js','audio.js','world.js','levels.js','render.js','game.js'].forEach(function(f){load('../js/'+f)});

var args = (typeof arguments !== 'undefined') ? arguments : [];
var LV = (args[0] ? parseInt(args[0], 10) : 3) - 1;
var VAR = args[1] ? parseInt(args[1], 10) : 0;
World.forceVariant = VAR;

function rowStr(w, r){ var s=''; for(var c=0;c<COLS;c++){ var ch=w.grid[r][c]; s+=(ch===' '?'.':ch); } return s; }

var w=new World(LEVELS[LV],Game); Game.world=w; Game.state='play'; Game.levelDeaths=0;
print('L'+(LV+1)+' '+LEVELS[LV].name+'  variant '+VAR+
      '   door col '+(w.door.x/16)+' fake='+!!w.door.fake+
      '   legs='+(w.stops?w.stops.length:1));
var jh=0, lastStop=0;
for(var f=0; f<2500; f++){
  var p=w.player, g=w.gravDir;
  var pc=Math.floor((p.x+p.w/2)/TILE), pr=Math.floor((p.y+p.h/2)/TILE);
  var dc=Math.floor((w.door.x+w.door.w/2)/TILE), dr=Math.floor((w.door.y+w.door.h/2)/TILE);
  var dir=dc>pc?1:(dc<pc?-1:1);
  var footR=g>0?pr+1:pr-1;
  Input.down=Object.create(null); Input.hit=Object.create(null);
  var at=0,wide=0;
  for(var d=1;d<=4;d++){ var c=pc+d*dir;
    var bad=isSpikeChar(w.at(c,pr))||isSpikeChar(w.at(c,footR))||!isSolidChar(w.at(c,footR));
    if(bad){ if(!at)at=d; wide++; } else if(at) break; }
  var doorAbove = g>0? dr<pr-1 : dr>pr+1;
  var k=dir>0?'right':'left'; if(w.mirror) k=(k==='right')?'left':'right';
  Input.down[k]=true;
  if(p.onGround&&jh===0&&((at&&at<=2)||isSolidChar(w.at(pc+dir,pr))||doorAbove)){
    Input.hit.jump=true; jh=Math.min(24,6+wide*5); }
  if(jh>0){ Input.down.jump=true; jh--; }
  w.update();
  if(w.stop!==undefined && w.stop!==lastStop){
    lastStop=w.stop;
    print('  f'+f+'  leg '+w.stop+'  door -> col '+(w.door.x/16));
    print('        row15 '+rowStr(w,15));
    print('        row16 '+rowStr(w,16));
  }
  if(w.state!=='play'){
    print('  f'+f+'  '+w.state+' at col '+(p.x/16).toFixed(1)+' ('+w.deathCause+')  leg '+(w.stop||0));
    w.movers.forEach(function(m,i){
      print('        mover'+i+' '+m.style+' cols '+(m.x/16).toFixed(1)+'-'+((m.x+m.w)/16).toFixed(1)+
            ' rows '+(m.y/16).toFixed(1)+'-'+((m.y+m.h)/16).toFixed(1)+' vx='+(m.vx||0)+' deadly='+!!m.deadly);
    });
    print('        row15 '+rowStr(w,15));
    print('        row16 '+rowStr(w,16));
    break;
  }
}
if(w.state==='play') print('  timeout at col '+(w.player.x/16).toFixed(1)+' leg '+(w.stop||0));
