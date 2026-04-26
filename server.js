const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket'],
    allowEIO3: true,
    pingInterval: 25000,
    pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));

// Game State Storage
const rooms = {};

// Utility: Generate Room Code
function generateRoomCode() {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < 5; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

// ===== SPATIAL GRID for fast wall collision lookups =====
function buildSpatialGrid(walls, mapSize) {
    const cellSize = 10;
    const gridW = Math.ceil(mapSize / cellSize) + 2;
    const gridH = Math.ceil(mapSize / cellSize) + 2;
    const grid = new Array(gridW * gridH);
    for (let i = 0; i < grid.length; i++) grid[i] = [];

    for (let wi = 0; wi < walls.length; wi++) {
        const wall = walls[wi];
        const minCX = Math.max(0, Math.floor((wall.x + 1) / cellSize));
        const maxCX = Math.min(gridW - 1, Math.floor((wall.x + wall.width + 1) / cellSize));
        const minCY = Math.max(0, Math.floor((wall.y + 1) / cellSize));
        const maxCY = Math.min(gridH - 1, Math.floor((wall.y + wall.height + 1) / cellSize));

        for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cy = minCY; cy <= maxCY; cy++) {
                grid[cy * gridW + cx].push(wi);
            }
        }
    }

    return { grid, cellSize, gridW, gridH };
}

function getWallsNear(spatialGrid, x, y, radius) {
    const { grid, cellSize, gridW, gridH } = spatialGrid;
    const minCX = Math.max(0, Math.floor((x - radius + 1) / cellSize));
    const maxCX = Math.min(gridW - 1, Math.floor((x + radius + 1) / cellSize));
    const minCY = Math.max(0, Math.floor((y - radius + 1) / cellSize));
    const maxCY = Math.min(gridH - 1, Math.floor((y + radius + 1) / cellSize));

    const seen = new Set();
    const result = [];

    for (let cx = minCX; cx <= maxCX; cx++) {
        for (let cy = minCY; cy <= maxCY; cy++) {
            const cell = grid[cy * gridW + cx];
            for (let i = 0; i < cell.length; i++) {
                const wi = cell[i];
                if (!seen.has(wi)) {
                    seen.add(wi);
                    result.push(wi);
                }
            }
        }
    }
    return result;
}

// Utility: Generate Map based on player count
function generateMap(playerCount) {
    let size = 50;
    let density = 0.05;
    
    if (playerCount >= 3 && playerCount <= 4) {
        size = 80;
        density = 0.1;
    } else if (playerCount >= 5) {
        size = 120;
        density = 0.15;
    }

    const walls = [];
    const cellSize = 10;
    const wallThickness = 2;
    
    const gw = Math.floor(size / cellSize);
    const gh = Math.floor(size / cellSize);
    
    const grid = [];
    for(let x=0; x<gw; x++) {
        grid[x] = [];
        for(let y=0; y<gh; y++) {
            grid[x][y] = { visited: false, right: true, bottom: true };
        }
    }
    
    const stack = [{x: 0, y: 0}];
    grid[0][0].visited = true;
    const dirs = [{dx: 0, dy: -1, name: 'top'}, {dx: 1, dy: 0, name: 'right'}, {dx: 0, dy: 1, name: 'bottom'}, {dx: -1, dy: 0, name: 'left'}];
    
    while(stack.length > 0) {
        const curr = stack[stack.length - 1];
        const unvisited = [];
        for (let d of dirs) {
            let nx = curr.x + d.dx, ny = curr.y + d.dy;
            if (nx >= 0 && nx < gw && ny >= 0 && ny < gh && !grid[nx][ny].visited) unvisited.push({nx, ny, dir: d.name});
        }
        if (unvisited.length > 0) {
            const next = unvisited[Math.floor(Math.random() * unvisited.length)];
            if (next.dir === 'right') grid[curr.x][curr.y].right = false;
            if (next.dir === 'left') grid[next.nx][next.ny].right = false;
            if (next.dir === 'bottom') grid[curr.x][curr.y].bottom = false;
            if (next.dir === 'top') grid[next.nx][next.ny].bottom = false;
            grid[next.nx][next.ny].visited = true;
            stack.push({x: next.nx, y: next.ny});
        } else {
            stack.pop();
        }
    }
    
    for(let x=0; x<gw; x++) {
        for(let y=0; y<gh; y++) {
            if (grid[x][y].right && Math.random() < 0.25 && x < gw - 1) grid[x][y].right = false;
            if (grid[x][y].bottom && Math.random() < 0.25 && y < gh - 1) grid[x][y].bottom = false;
            
            const px = x * cellSize;
            const py = y * cellSize;
            if (grid[x][y].right && x < gw - 1) {
                walls.push({ x: px + cellSize - wallThickness/2, y: py - wallThickness/2, width: wallThickness, height: cellSize + wallThickness });
            }
            if (grid[x][y].bottom && y < gh - 1) {
                walls.push({ x: px - wallThickness/2, y: py + cellSize - wallThickness/2, width: cellSize + wallThickness, height: wallThickness });
            }
        }
    }

    // Outer boundaries
    walls.push({ x: -1, y: -1, width: size + 2, height: 1, isBoundary: true });
    walls.push({ x: -1, y: size, width: size + 2, height: 1, isBoundary: true });
    walls.push({ x: -1, y: -1, width: 1, height: size + 2, isBoundary: true });
    walls.push({ x: size, y: -1, width: 1, height: size + 2, isBoundary: true });

    const spatialGrid = buildSpatialGrid(walls, size);
    return { size, walls, spatialGrid };
}

// Map Collision Check (AABB)
function checkCollision(rect1, rect2) {
    return (
        rect1.x < rect2.x + rect2.width &&
        rect1.x + rect1.width > rect2.x &&
        rect1.y < rect2.y + rect2.height &&
        rect1.y + rect1.height > rect2.y
    );
}

// Circle - Rect Collision (no sqrt)
function circleRectCollision(cx, cy, radius, rx, ry, rw, rh) {
    let testX = cx;
    let testY = cy;

    if (cx < rx) testX = rx;
    else if (cx > rx + rw) testX = rx + rw;
    
    if (cy < ry) testY = ry;
    else if (cy > ry + rh) testY = ry + rh;

    const distX = cx - testX;
    const distY = cy - testY;
    return (distX * distX + distY * distY) <= radius * radius;
}

const colors = ["#FF5733", "#33FF57", "#3357FF", "#F1C40F", "#9B59B6", "#1ABC9C", "#E67E22", "#E74C3C"];
const TEAM_COLORS = { A: '#e74c3c', B: '#3498db' };

// Sanitize username
function sanitizeName(name) {
    if (!name || typeof name !== 'string') return '';
    return name.replace(/[<>&"'\/\\]/g, '').trim().substring(0, 16);
}

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('createRoom', ({ mode, username }) => {
        const name = sanitizeName(username);
        if (!name || name.length < 1) {
            socket.emit('errorMsg', 'Lütfen bir kullanıcı adı girin.');
            return;
        }

        let code = generateRoomCode();
        while (rooms[code]) code = generateRoomCode();

        rooms[code] = {
            id: code,
            host: socket.id,
            mode: mode,
            status: 'waiting',
            players: {},
            spectators: {},  // Players who joined mid-game
            bullets: [],
            mapData: null,
            chatHistory: [],  // Store last 50 messages
            teamSize: 2,  // Default team size for team mode
            teamScores: { A: 0, B: 0 }  // Team scores
        };

        joinRoom(socket, code, name);
    });

    socket.on('joinRoom', ({ code, username }) => {
        const name = sanitizeName(username);
        if (!name || name.length < 1) {
            socket.emit('errorMsg', 'Lütfen bir kullanıcı adı girin.');
            return;
        }

        code = code.toUpperCase();
        if (!rooms[code]) {
            socket.emit('errorMsg', 'Oda bulunamadı.');
            return;
        }

        const room = rooms[code];

        if (room.status === 'waiting') {
            // Normal lobby join
            joinRoom(socket, code, name);
        } else if (room.status === 'playing' || room.status === 'round_over') {
            // Mid-game join as spectator
            joinMidGame(socket, code, name);
        } else {
            socket.emit('errorMsg', 'Bu odaya şu anda katılamazsınız.');
        }
    });

    function joinRoom(socket, code, playerName) {
        const room = rooms[code];
        const maxPlayers = room.mode === 'team' ? room.teamSize * 2 : 8;
        if (Object.keys(room.players).length >= maxPlayers) {
            socket.emit('errorMsg', 'Oda dolu.');
            return;
        }

        socket.join(code);
        
        // Determine team and color
        let team = null;
        let color;
        if (room.mode === 'team') {
            // Auto-assign to team with fewer players
            const teamACount = Object.values(room.players).filter(p => p.team === 'A').length;
            const teamBCount = Object.values(room.players).filter(p => p.team === 'B').length;
            team = teamACount <= teamBCount ? 'A' : 'B';
            color = TEAM_COLORS[team];
        } else {
            const usedColors = Object.values(room.players).map(p => p.color);
            const availableColors = colors.filter(c => !usedColors.includes(c));
            color = availableColors[0] || "#FFFFFF";
        }

        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            color: color,
            x: 0,
            y: 0,
            angle: 0,
            hp: 1,
            score: 0,
            lastShot: 0,
            isHost: room.host === socket.id,
            team: team
        };

        socket.roomCode = code;
        socket.emit('joined', { code, isHost: room.host === socket.id, id: socket.id, mode: room.mode, teamSize: room.teamSize });
        emitLobbyUpdate(room, code);
    }

    // Mid-game join: player enters as dead spectator, will be alive next round
    function joinMidGame(socket, code, playerName) {
        const room = rooms[code];
        const maxPlayers = room.mode === 'team' ? room.teamSize * 2 : 8;
        const totalPlayers = Object.keys(room.players).length;
        if (totalPlayers >= maxPlayers) {
            socket.emit('errorMsg', 'Oda dolu.');
            return;
        }

        socket.join(code);

        // Determine team and color
        let team = null;
        let color;
        if (room.mode === 'team') {
            const teamACount = Object.values(room.players).filter(p => p.team === 'A').length;
            const teamBCount = Object.values(room.players).filter(p => p.team === 'B').length;
            team = teamACount <= teamBCount ? 'A' : 'B';
            color = TEAM_COLORS[team];
        } else {
            const usedColors = Object.values(room.players).map(p => p.color);
            const availableColors = colors.filter(c => !usedColors.includes(c));
            color = availableColors[0] || "#FFFFFF";
        }

        // Add as player but with hp=0 (dead/spectating)
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            color: color,
            x: room.mapData ? room.mapData.size / 2 : 0,
            y: room.mapData ? room.mapData.size / 2 : 0,
            angle: 0,
            hp: 0,  // Dead — spectating until next round
            score: 0,
            lastShot: 0,
            isHost: false,
            team: team
        };

        socket.roomCode = code;

        // Send current game state to the new joiner
        const clientMapData = {
            size: room.mapData.size,
            walls: room.mapData.walls
        };

        socket.emit('joinedMidGame', {
            code,
            id: socket.id,
            mapData: clientMapData,
            players: room.players,
            chatHistory: room.chatHistory,
            mode: room.mode,
            teamScores: room.teamScores
        });

        // Notify everyone about the new player
        io.to(code).emit('chatMessage', {
            type: 'system',
            text: `${playerName} oyuna katıldı (izleyici olarak)`
        });
    }

    // Emit lobby update helper
    function emitLobbyUpdate(room, code) {
        io.to(code).emit('updateLobby', {
            players: Object.values(room.players),
            mode: room.mode,
            teamSize: room.teamSize,
            teamScores: room.teamScores
        });
    }

    // ===== CHAT =====
    socket.on('chatMessage', (text) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (!room || !room.players[socket.id]) return;

        // Sanitize and limit message
        const cleanText = String(text).replace(/[<>&]/g, '').trim().substring(0, 100);
        if (!cleanText) return;

        const msg = {
            type: 'player',
            sender: room.players[socket.id].name,
            color: room.players[socket.id].color,
            text: cleanText,
            time: Date.now()
        };

        // Store in history (max 50)
        room.chatHistory.push(msg);
        if (room.chatHistory.length > 50) room.chatHistory.shift();

        io.to(socket.roomCode).emit('chatMessage', msg);
    });

    socket.on('changeColor', (color) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (room && room.status === 'waiting' && room.players[socket.id]) {
            // In team mode, color is determined by team — ignore manual color changes
            if (room.mode === 'team') return;
            const isUsed = Object.values(room.players).some(p => p.color === color && p.id !== socket.id);
            if (!isUsed) {
                room.players[socket.id].color = color;
                emitLobbyUpdate(room, socket.roomCode);
            }
        }
    });

    // Team switching
    socket.on('switchTeam', (team) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (!room || room.mode !== 'team' || room.status !== 'waiting') return;
        if (team !== 'A' && team !== 'B') return;

        const player = room.players[socket.id];
        if (!player) return;

        // Check if target team is full
        const teamCount = Object.values(room.players).filter(p => p.team === team).length;
        if (teamCount >= room.teamSize) {
            socket.emit('errorMsg', 'Bu takım dolu.');
            return;
        }

        player.team = team;
        player.color = TEAM_COLORS[team];
        emitLobbyUpdate(room, socket.roomCode);
    });

    // Team size change (host only)
    socket.on('setTeamSize', (size) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (!room || room.host !== socket.id || room.mode !== 'team' || room.status !== 'waiting') return;
        size = parseInt(size);
        if (size < 2 || size > 10) return;
        room.teamSize = size;
        emitLobbyUpdate(room, socket.roomCode);
    });

    socket.on('startGame', () => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (room && room.host === socket.id && room.status === 'waiting') {
            room.status = 'playing';
            room.teamScores = { A: 0, B: 0 };
            startNewRound(room, socket.roomCode);
        }
    });

    socket.on('playerInput', (input) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (!room || room.status !== 'playing') return;

        const player = room.players[socket.id];
        if (!player || player.hp <= 0) return;

        const speed = 0.5;
        player.angle = input.angle;

        let dx = 0;
        let dy = 0;
        
        if (input.up) dy -= 1;
        if (input.down) dy += 1;
        if (input.left) dx -= 1;
        if (input.right) dx += 1;

        if (dx !== 0 || dy !== 0) {
            const dist = Math.sqrt(dx * dx + dy * dy);
            dx = (dx / dist) * speed;
            dy = (dy / dist) * speed;
        }

        const playerSize = 2;
        let hitWallX = false;
        let hitWallY = false;

        // X ekseni için çarpışma kontrolü
        if (dx !== 0) {
            const testRectX = { x: player.x + dx - playerSize/2, y: player.y - playerSize/2, width: playerSize, height: playerSize };
            const nearbyX = getWallsNear(room.mapData.spatialGrid, player.x + dx, player.y, playerSize);
            for (let j = 0; j < nearbyX.length; j++) {
                if (checkCollision(testRectX, room.mapData.walls[nearbyX[j]])) {
                    hitWallX = true;
                    break;
                }
            }
        }

        // Y ekseni için çarpışma kontrolü
        if (dy !== 0) {
            const testRectY = { x: player.x - playerSize/2, y: player.y + dy - playerSize/2, width: playerSize, height: playerSize };
            const nearbyY = getWallsNear(room.mapData.spatialGrid, player.x, player.y + dy, playerSize);
            for (let j = 0; j < nearbyY.length; j++) {
                if (checkCollision(testRectY, room.mapData.walls[nearbyY[j]])) {
                    hitWallY = true;
                    break;
                }
            }
        }

        // Duvara yaslanmışken sürüklenme hızı faktörü (çok yavaş)
        const slideFactor = 0.25;

        // X'te duvara çarpmadıysak ilerle (Y'de duvara sürtünüyorsak hızı düşür)
        if (dx !== 0 && !hitWallX) {
            player.x += hitWallY ? dx * slideFactor : dx;
        }

        // Y'de duvara çarpmadıysak ilerle (X'te duvara sürtünüyorsak hızı düşür)
        if (dy !== 0 && !hitWallY) {
            player.y += hitWallX ? dy * slideFactor : dy;
        }

        if (input.isShooting) {
            const now = Date.now();
            if (now - player.lastShot > 800) {
                player.lastShot = now;
                const spawnDist = 1.0;
                room.bullets.push({
                    x: player.x + Math.cos(player.angle) * spawnDist,
                    y: player.y + Math.sin(player.angle) * spawnDist,
                    vx: Math.cos(player.angle) * 1.5,
                    vy: Math.sin(player.angle) * 1.5,
                    owner: socket.id,
                    bounces: 3,
                    createdAt: now
                });
            }
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomCode && rooms[socket.roomCode]) {
            const room = rooms[socket.roomCode];
            delete room.players[socket.id];
            
            if (Object.keys(room.players).length === 0) {
                delete rooms[socket.roomCode];
            } else {
                if (room.host === socket.id) {
                    room.host = Object.keys(room.players)[0];
                    room.players[room.host].isHost = true;
                }
                emitLobbyUpdate(room, socket.roomCode);

                // If game is playing, check if round should end
                if (room.status === 'playing') {
                    checkRoundEnd(room, socket.roomCode);
                }
            }
        }
        console.log('User disconnected:', socket.id);
    });
});

// Check if a round should end
function checkRoundEnd(room, code) {
    const alivePlayers = Object.values(room.players).filter(pl => pl.hp > 0);

    if (room.mode === 'team') {
        // Team mode: round ends when one team has no alive players
        const aliveTeamA = alivePlayers.filter(p => p.team === 'A');
        const aliveTeamB = alivePlayers.filter(p => p.team === 'B');

        if (aliveTeamA.length === 0 || aliveTeamB.length === 0) {
            let winnerTeam = null;
            if (aliveTeamA.length > 0) winnerTeam = 'A';
            else if (aliveTeamB.length > 0) winnerTeam = 'B';

            if (winnerTeam) {
                room.teamScores[winnerTeam]++;
                const teamLabel = winnerTeam === 'A' ? '🔴 Team A' : '🔵 Team B';
                io.to(code).emit('roundWinner', { winner: winnerTeam, name: teamLabel, isTeam: true, teamScores: room.teamScores });
            }

            room.status = 'round_over';
            setTimeout(() => {
                if (rooms[code]) {
                    rooms[code].status = 'playing';
                    startNewRound(rooms[code], code);
                }
            }, 3000);
        }
    } else {
        // FFA mode
        if (alivePlayers.length <= 1) {
            if (alivePlayers.length === 1) {
                io.to(code).emit('roundWinner', { winner: alivePlayers[0].id, name: alivePlayers[0].name });
            }
            room.status = 'round_over';
            setTimeout(() => {
                if (rooms[code]) {
                    rooms[code].status = 'playing';
                    startNewRound(rooms[code], code);
                }
            }, 3000);
        }
    }
}

// Server Game Loop

function startNewRound(room, code) {
    const playerCount = Object.keys(room.players).length;
    room.mapData = generateMap(playerCount);
    room.bullets = [];

    // Spawn ALL players (including mid-game joiners who were spectating)
    for (let id in room.players) {
        const player = room.players[id];
        const gridX = Math.floor(Math.random() * (room.mapData.size / 10));
        const gridY = Math.floor(Math.random() * (room.mapData.size / 10));
        player.x = gridX * 10 + 5;
        player.y = gridY * 10 + 5;
        player.hp = 1;
        player.angle = 0;
    }

    const clientMapData = {
        size: room.mapData.size,
        walls: room.mapData.walls
    };

    io.to(code).emit('newRound', {
        mapData: clientMapData,
        players: room.players
    });
}

setInterval(() => {
    for (let code in rooms) {
        const room = rooms[code];
        if (room.status !== 'playing') continue;

        const walls = room.mapData.walls;
        const spatialGrid = room.mapData.spatialGrid;
        const now = Date.now();

        const bullets = room.bullets;

        for (let i = bullets.length - 1; i >= 0; i--) {
            const b = bullets[i];
            let removeBullet = false;
            
            const steps = 3;
            const stepVx = b.vx / steps;
            const stepVy = b.vy / steps;
            let hitWall = null;
            const bulletRadius = 0.2;
            
            for (let step = 0; step < steps; step++) {
                b.x += stepVx;
                b.y += stepVy;
                
                const nearbyIndices = getWallsNear(spatialGrid, b.x, b.y, bulletRadius + 2);
                for (let j = 0; j < nearbyIndices.length; j++) {
                    const wall = walls[nearbyIndices[j]];
                    if (circleRectCollision(b.x, b.y, bulletRadius, wall.x, wall.y, wall.width, wall.height)) {
                        hitWall = wall;
                        break;
                    }
                }
                if (hitWall) break;
            }

            if (hitWall) {
                if (b.bounces > 0) {
                    b.bounces--;
                    const overlapLeft = b.x + bulletRadius - hitWall.x;
                    const overlapRight = hitWall.x + hitWall.width - (b.x - bulletRadius);
                    const overlapTop = b.y + bulletRadius - hitWall.y;
                    const overlapBottom = hitWall.y + hitWall.height - (b.y - bulletRadius);
                    
                    const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
                    
                    if (minOverlap === overlapLeft) { b.vx = -Math.abs(b.vx); b.x = hitWall.x - bulletRadius - 0.05; }
                    else if (minOverlap === overlapRight) { b.vx = Math.abs(b.vx); b.x = hitWall.x + hitWall.width + bulletRadius + 0.05; }
                    else if (minOverlap === overlapTop) { b.vy = -Math.abs(b.vy); b.y = hitWall.y - bulletRadius - 0.05; }
                    else if (minOverlap === overlapBottom) { b.vy = Math.abs(b.vy); b.y = hitWall.y + hitWall.height + bulletRadius + 0.05; }
                } else {
                    removeBullet = true;
                }
            }

            if (!removeBullet) {
                const ownerPlayer = room.players[b.owner];
                for (let pid in room.players) {
                    const p = room.players[pid];
                    if (p.hp <= 0) continue;
                    if (b.owner === pid && (now - b.createdAt <= 200)) continue;

                    // Friendly fire prevention in team mode
                    if (room.mode === 'team' && ownerPlayer && ownerPlayer.team === p.team && b.owner !== pid) continue;

                    if (circleRectCollision(b.x, b.y, bulletRadius, p.x - 1, p.y - 1, 2, 2)) {
                        p.hp -= 1;
                        removeBullet = true;
                        
                        if (p.hp <= 0) {
                            if (ownerPlayer && b.owner !== pid) {
                                ownerPlayer.score += 1;
                            }
                            io.to(code).emit('playerDied', { victim: pid, killer: b.owner });
                            checkRoundEnd(room, code);
                        }
                        break;
                    }
                }
            }

            if (removeBullet) {
                bullets[i] = bullets[bullets.length - 1];
                bullets.pop();
            }
        }

        // Build compact gameState
        const optimizedPlayers = {};
        for (let pid in room.players) {
            const p = room.players[pid];
            optimizedPlayers[pid] = {
                id: p.id,
                n: p.name,
                x: Math.round(p.x * 100) / 100,
                y: Math.round(p.y * 100) / 100,
                a: Math.round(p.angle * 100) / 100,
                hp: p.hp,
                s: p.score,
                c: p.color,
                t: p.team || null
            };
        }

        const compactBullets = new Array(bullets.length);
        for (let i = 0; i < bullets.length; i++) {
            compactBullets[i] = {
                x: Math.round(bullets[i].x * 100) / 100,
                y: Math.round(bullets[i].y * 100) / 100
            };
        }

        io.to(code).emit('gameState', {
            players: optimizedPlayers,
            bullets: compactBullets,
            mode: room.mode,
            teamScores: room.mode === 'team' ? room.teamScores : null
        });
    }
}, 1000 / 20);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
