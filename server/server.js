const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const rooms = new Map();
const COLS = 5, ROWS = 9;

function makeId() {
  return crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[-_]/g,'').slice(0,8);
}
function newRoom() {
  let id;
  do id = makeId(); while (rooms.has(id));
  return {
    id,
    starter: 'blue',
    nextStarter: 'red',
    phase: 'placement',
    placementIndex: 0,
    pieces: [],
    turnColor: 'blue',
    moveCount: {blue:0, red:0},
    scores: {blue:0, red:0},
    winnerColor: null,
    matchWinner: null,
    players: {blue:null, red:null},
    connections: new Set(),
    restartTimer: null
  };
}
function send(ws, msg){ if(ws && ws.readyState===1) ws.send(JSON.stringify(msg)); }
function publicState(room) {
  return {
    id: room.id,
    phase: room.phase,
    starter: room.starter,
    placementIndex: room.placementIndex,
    pieces: room.pieces,
    turnColor: room.turnColor,
    moveCount: room.moveCount,
    scores: room.scores,
    winnerColor: room.winnerColor,
    matchWinner: room.matchWinner,
    player1Connected: !!room.players.blue?.ws,
    player2Connected: !!room.players.red?.ws
  };
}
function broadcast(room){
  const st = publicState(room);
  for(const ws of room.connections) send(ws,{type:'state',state:st,yourColor:ws.playerColor||null});
}
function piecesAt(room,r,c){ return room.pieces.filter(p=>p.r===r&&p.c===c); }
function validPlacement(room,r,c,color){
  if(!Number.isInteger(r)||!Number.isInteger(c)||r<0||r>=ROWS||c<0||c>=COLS)return false;
  for(const p of room.pieces){
    const dr=Math.abs(p.r-r), dc=Math.abs(p.c-c);
    if(dr<=1&&dc<=1)return false;
  }
  const same=room.pieces.find(p=>p.color===color);
  if(same){
    const dr=Math.abs(same.r-r), dc=Math.abs(same.c-c);
    const whiteDistance=Math.max(dr-1,0)+Math.max(dc-1,0);
    if(whiteDistance<3)return false;
  }
  return true;
}
function placementColor(room){
  const first=room.starter, second=first==='blue'?'red':'blue';
  return [first,second,first,second][room.placementIndex];
}
function canMovePiece(room,p,r,c){
  if(!p)return {ok:false,reason:'Pieza inexistente.'};
  if(r<0||r>=ROWS||c<0||c>=COLS)return {ok:false,reason:'Destino fuera del tablero.'};
  if(r===p.r&&c===p.c)return {ok:false,reason:'La pieza ya está en esa casilla.'};

  const dr=r-p.r,dc=c-p.c,adr=Math.abs(dr),adc=Math.abs(dc);
  const destination=piecesAt(room,r,c);
  const ownAtDestination=destination.find(q=>q.color===p.color);
  if(ownAtDestination)return {ok:false,reason:'No podés ocupar una casilla con tu propia pieza.'};

  // Movimiento normal: exactamente un casillero.
  const one=p.shape==='diamond'
    ? ((adr===1&&adc===0)||(adr===0&&adc===1))
    : (adr===1&&adc===1);

  if(one){
    if(destination.length===0)return {ok:true,capture:null};
    const enemy=destination.find(q=>q.color!==p.color);
    return enemy
      ? {ok:true,capture:enemy}
      : {ok:false,reason:'Casilla ocupada.'};
  }

  // Captura a distancia: solo sobre la línea de movimiento de la pieza.
  const target=destination.find(q=>q.color!==p.color);
  if(!target)return {ok:false,reason:'Los movimientos de más de un casillero solo sirven para capturar.'};

  let sr=0,sc=0;
  if(p.shape==='diamond'){
    if(adr===0&&adc>0) sc=dc>0?1:-1;
    else if(adc===0&&adr>0) sr=dr>0?1:-1;
    else return {ok:false,reason:'El rombo solo se mueve horizontal o verticalmente.'};
  } else {
    if(adr!==adc||adr===0)return {ok:false,reason:'El cuadrado solo se mueve en diagonal.'};
    sr=dr>0?1:-1;
    sc=dc>0?1:-1;
  }

  let rr=p.r+sr,cc=p.c+sc;
  while(rr!==r||cc!==c){
    if(piecesAt(room,rr,cc).length>0)
      return {ok:false,reason:'No podés saltar una pieza.'};
    rr+=sr;
    cc+=sc;
  }

  return {ok:true,capture:target};
}
function hasVictory(room,color){
  const own=room.pieces.filter(p=>p.color===color);
  const enemy=room.pieces.filter(p=>p.color!==color);
  if(enemy.length<2)return true;
  if(own.length===2){
    const dr=Math.abs(own[0].r-own[1].r),dc=Math.abs(own[0].c-own[1].c);
    if(dr<=1&&dc<=1&&(dr+dc)>0)return true;
  }
  return false;
}
function finishResult(room){
  const blueWin=hasVictory(room,'blue'), redWin=hasVictory(room,'red');
  if(!blueWin&&!redWin)return false;
  if(room.moveCount.blue!==room.moveCount.red)return false;
  room.phase='finished';
  room.winnerColor=(blueWin&&!redWin)?'blue':(redWin&&!blueWin)?'red':null;
  if(room.winnerColor){
    room.scores[room.winnerColor]++;
    if(room.scores[room.winnerColor]>=5) room.matchWinner=room.winnerColor;
  }
  broadcast(room);
  if(!room.matchWinner){
    room.restartTimer=setTimeout(()=>startNextGame(room),3000);
  }
  return true;
}
function startNextGame(room){
  room.restartTimer=null;
  room.pieces=[];
  room.placementIndex=0;
  room.moveCount={blue:0,red:0};
  room.winnerColor=null;
  room.matchWinner=null;
  room.phase='placement';
  room.starter=room.nextStarter;
  room.nextStarter=room.nextStarter==='blue'?'red':'blue';
  room.turnColor=room.starter;
  broadcast(room);
}
function resetRoom(room, ws){
  if(room.phase==='start'){
    const loser=room.turnColor, winner=loser==='blue'?'red':'blue';
    room.scores[winner]++;
    if(room.scores[winner]>=5){
      room.matchWinner=winner;
      room.phase='finished';
      room.winnerColor=winner;
      broadcast(room);
      return;
    }
    room.nextStarter=room.starter==='blue'?'red':'blue';
    room.starter=room.nextStarter;
  } else if(room.phase==='finished'&&room.matchWinner){
    room.scores={blue:0,red:0};
    room.starter=room.starter==='blue'?'red':'blue';
    room.nextStarter=room.starter==='blue'?'red':'blue';
  }
  if(room.restartTimer){clearTimeout(room.restartTimer);room.restartTimer=null;}
  room.pieces=[];room.placementIndex=0;room.moveCount={blue:0,red:0};room.winnerColor=null;room.matchWinner=null;room.phase='placement';room.turnColor=room.starter;
  broadcast(room);
}
function assignPlayer(room,ws,token){
  for(const color of ['blue','red']){
    const p=room.players[color];
    if(p && p.token===token){
      p.ws=ws; ws.playerColor=color; ws.roomId=room.id; return color;
    }
  }
  for(const color of ['blue','red']){
    if(!room.players[color]){
      room.players[color]={token,ws}; ws.playerColor=color; ws.roomId=room.id; return color;
    }
  }
  return null;
}
function createRoomAndJoin(ws,token){
  const room=newRoom();rooms.set(room.id,room);const color=assignPlayer(room,ws,token);room.connections.add(ws);
  send(ws,{type:'created',roomId:room.id,color});send(ws,{type:'joined',color});broadcast(room);
}
function joinRoom(ws,roomId,token){
  const room=rooms.get(roomId);
  if(!room)return send(ws,{type:'error',message:'La partida no existe o el link no es válido.',fatal:true});
  const existing=['blue','red'].find(c=>room.players[c]?.token===token);
  if(!existing && room.players.blue?.ws && room.players.red?.ws)return send(ws,{type:'error',message:'Esta partida ya tiene dos jugadores conectados.'});
  const color=assignPlayer(room,ws,token);
  if(!color)return send(ws,{type:'error',message:'No hay lugar para otro jugador en esta partida.'});
  room.connections.add(ws);send(ws,{type:'joined',color});broadcast(room);
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;}
  res.writeHead(404);res.end('Not found');
});
const wss=new WebSocketServer({server});
wss.on('connection',(ws)=>{
  ws.on('message',(raw)=>{
    let msg;try{msg=JSON.parse(raw.toString())}catch{return}
    const token=msg.token;
    if(msg.type==='create'){return createRoomAndJoin(ws,token)}
    if(msg.type==='join'){
      if(!msg.roomId)return send(ws,{type:'error',message:'Falta el identificador de partida.'});
      return joinRoom(ws,msg.roomId,token);
    }
    const room=rooms.get(ws.roomId);
    if(!room || !ws.playerColor)return;
    const color=ws.playerColor;
    if(msg.type==='place'){
      if(room.phase!=='placement'||placementColor(room)!==color)return;
      if(!validPlacement(room,msg.r,msg.c,color))return;
      const existing=room.pieces.find(p=>p.color===color);
      let shape=msg.shape==='square'?'square':'diamond';
      if(existing)shape=existing.shape==='diamond'?'square':'diamond';
      const id=crypto.randomUUID();
      room.pieces.push({id,color,shape,r:msg.r,c:msg.c});
      room.placementIndex++;
      if(room.placementIndex>=4){room.phase='start';room.turnColor=room.starter;}
      broadcast(room);return;
    }
    if(msg.type==='move'){
      if(room.phase!=='start'){
        return send(ws,{type:'error',message:'La partida todavía no está en fase de movimiento.'});
      }
      if(room.turnColor!==color){
        return send(ws,{type:'error',message:'Todavía no es tu turno.'});
      }

      const p=room.pieces.find(x=>x.id===msg.pieceId&&x.color===color);
      if(!p){
        return send(ws,{type:'error',message:'No se encontró esa pieza.'});
      }

      const r=Number(msg.r),c=Number(msg.c);
      if(!Number.isInteger(r)||!Number.isInteger(c)){
        return send(ws,{type:'error',message:'Destino inválido.'});
      }

      const result=canMovePiece(room,p,r,c);
      if(!result.ok){
        return send(ws,{type:'error',message:result.reason||'Movimiento no válido.'});
      }

      if(result.capture){
        room.pieces=room.pieces.filter(x=>x.id!==result.capture.id);
      }

      p.r=r;
      p.c=c;
      room.moveCount[color]++;

      if(finishResult(room))return;

      room.turnColor=color==='blue'?'red':'blue';
      broadcast(room);
      return;
    }
    if(msg.type==='reset')return resetRoom(room,ws);
  });
  ws.on('close',()=>{
    const room=rooms.get(ws.roomId);if(!room)return;
    if(room.players[ws.playerColor]?.ws===ws)room.players[ws.playerColor].ws=null;
    room.connections.delete(ws);
    broadcast(room);
  });
});
server.listen(PORT,()=>console.log(`Rombo y Cuadrado server listening on ${PORT}`));
