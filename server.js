const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    transports: ['websocket'], // HTTP polling'i devre dışı bırakır, lagı azaltır
    allowEIO3: true,
    pingInterval: 2000,        // Bağlantıyı zinde tutar
    pingTimeout: 5000
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

// Utility: Generate Map based on player count
function generateMap(playerCount) {
    let size = 50;
    let density = 0.05; // 5% of map is obstacles
    
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
    walls.push({ x: -1, y: -1, width: size + 2, height: 1, isBoundary: true }); // Top
    walls.push({ x: -1, y: size, width: size + 2, height: 1, isBoundary: true }); // Bottom
    walls.push({ x: -1, y: -1, width: 1, height: size + 2, isBoundary: true }); // Left
    walls.push({ x: size, y: -1, width: 1, height: size + 2, isBoundary: true }); // Right

    return { size, walls };
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

// Circle - Rect Collision
function circleRectCollision(circle, rect) {
    let testX = circle.x;
    let testY = circle.y;

    if (circle.x < rect.x) testX = rect.x;
    else if (circle.x > rect.x + rect.width) testX = rect.x + rect.width;
    
    if (circle.y < rect.y) testY = rect.y;
    else if (circle.y > rect.y + rect.height) testY = rect.y + rect.height;

    let distX = circle.x - testX;
    let distY = circle.y - testY;
    let distance = Math.sqrt((distX*distX) + (distY*distY));

    return distance <= circle.radius;
}

const colors = ["#FF5733", "#33FF57", "#3357FF", "#F1C40F", "#9B59B6", "#1ABC9C", "#E67E22", "#E74C3C"];

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('createRoom', ({ mode }) => {
        let code = generateRoomCode();
        while (rooms[code]) code = generateRoomCode();

        rooms[code] = {
            id: code,
            host: socket.id,
            mode: mode, // 'ffa' or 'team'
            status: 'waiting',
            players: {},
            bullets: [],
            mapData: null
        };

        joinRoom(socket, code);
    });

    socket.on('joinRoom', (code) => {
        code = code.toUpperCase();
        if (rooms[code] && rooms[code].status === 'waiting') {
            joinRoom(socket, code);
        } else {
            socket.emit('errorMsg', 'Oda bulunamadı veya oyun zaten başlamış.');
        }
    });

    function joinRoom(socket, code) {
        const room = rooms[code];
        if (Object.keys(room.players).length >= 8) {
            socket.emit('errorMsg', 'Oda dolu.');
            return;
        }

        socket.join(code);
        
        // Assign color
        const usedColors = Object.values(room.players).map(p => p.color);
        const availableColors = colors.filter(c => !usedColors.includes(c));
        const color = availableColors[0] || "#FFFFFF";

        room.players[socket.id] = {
            id: socket.id,
            name: `Player ${Object.keys(room.players).length + 1}`,
            color: color,
            x: 0,
            y: 0,
            angle: 0,
            hp: 1,
            score: 0,
            lastShot: 0,
            isHost: room.host === socket.id
        };

        socket.roomCode = code;
        socket.emit('joined', { code, isHost: room.host === socket.id, id: socket.id });
        io.to(code).emit('updateLobby', Object.values(room.players));
    }

    socket.on('changeColor', (color) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (room && room.status === 'waiting' && room.players[socket.id]) {
            const isUsed = Object.values(room.players).some(p => p.color === color && p.id !== socket.id);
            if (!isUsed) {
                room.players[socket.id].color = color;
                io.to(socket.roomCode).emit('updateLobby', Object.values(room.players));
            }
        }
    });

    socket.on('startGame', () => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (room && room.host === socket.id && room.status === 'waiting') {
            room.status = 'playing';
            startNewRound(room, socket.roomCode);
        }
    });

    socket.on('playerInput', (input) => {
        if (!socket.roomCode) return;
        const room = rooms[socket.roomCode];
        if (!room || room.status !== 'playing') return;

        const player = room.players[socket.id];
        if (!player || player.hp <= 0) return;

        // input: { up, angle, isShooting }
        const speed = 0.5; // units per tick

        player.angle = input.angle; // Tank always faces the mouse

        let newX = player.x;
        let newY = player.y;

        // W key moves the tank in the direction it's facing
        if (input.up) {
            newX += Math.cos(player.angle) * speed;
            newY += Math.sin(player.angle) * speed;
        }

        // Collision with walls
        const playerSize = 2; // radius or half-width
        const playerRect = { x: newX - playerSize/2, y: newY - playerSize/2, width: playerSize, height: playerSize };
        let hitWall = false;

        for (let wall of room.mapData.walls) {
            if (checkCollision(playerRect, wall)) {
                hitWall = true;
                break;
            }
        }

        if (!hitWall) {
            player.x = newX;
            player.y = newY;
        }

        // Shooting
        if (input.isShooting) {
            const now = Date.now();
            if (now - player.lastShot > 800) { // 0.8s cooldown
                player.lastShot = now;
                const spawnDist = 1.0; // edge of tank
                room.bullets.push({
                    x: player.x + Math.cos(player.angle) * spawnDist,
                    y: player.y + Math.sin(player.angle) * spawnDist,
                    vx: Math.cos(player.angle) * 1.5,
                    vy: Math.sin(player.angle) * 1.5,
                    owner: socket.id,
                    bounces: 3, // Allow 3 bounces
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
                delete rooms[socket.roomCode]; // Clean up empty room
            } else {
                if (room.host === socket.id) {
                    room.host = Object.keys(room.players)[0]; // Assign new host
                    room.players[room.host].isHost = true;
                }
                io.to(socket.roomCode).emit('updateLobby', Object.values(room.players));
            }
        }
        console.log('User disconnected:', socket.id);
    });
});

// Server Game Loop

function startNewRound(room, code) {
    const playerCount = Object.keys(room.players).length;
    room.mapData = generateMap(playerCount);
    room.bullets = [];

    // Spawn players
    for (let id in room.players) {
        const player = room.players[id];
        const gridX = Math.floor(Math.random() * (room.mapData.size / 10));
        const gridY = Math.floor(Math.random() * (room.mapData.size / 10));
        player.x = gridX * 10 + 5;
        player.y = gridY * 10 + 5;
        player.hp = 1;
        player.angle = 0;
    }

    io.to(code).emit('newRound', {
        mapData: room.mapData,
        players: room.players
    });
}

setInterval(() => {
    for (let code in rooms) {
        const room = rooms[code];
        if (room.status === 'playing') {
            // Update bullets
            for (let i = room.bullets.length - 1; i >= 0; i--) {
                const b = room.bullets[i];
                
                // Merminin duvardan geçmesini önlemek için hareketi küçük adımlara böl
                const steps = 4;
                const stepVx = b.vx / steps;
                const stepVy = b.vy / steps;
                let hitWall = null;
                const bulletRadius = 0.2;
                
                for (let step = 0; step < steps; step++) {
                    b.x += stepVx;
                    b.y += stepVy;
                    
                    const bulletCircle = { x: b.x, y: b.y, radius: bulletRadius };
                    for (let wall of room.mapData.walls) {
                        if (circleRectCollision(bulletCircle, wall)) {
                            hitWall = wall;
                            break;
                        }
                    }
                    if (hitWall) break;
                }

                if (hitWall) {
                    if (b.bounces > 0) {
                        b.bounces--;
                        // Push bullet out of the wall
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
                        room.bullets.splice(i, 1);
                        continue;
                    }
                }

                // Player collision
                const finalBulletCircle = { x: b.x, y: b.y, radius: bulletRadius };
                for (let pid in room.players) {
                    const p = room.players[pid];
                    // A bullet cannot hit its own shooter for the first 200ms (prevents instant suicide when shooting walls)
                    if (p.hp > 0 && (b.owner !== pid || (Date.now() - b.createdAt > 200))) {
                        const playerRect = { x: p.x - 1, y: p.y - 1, width: 2, height: 2 };
                        if (circleRectCollision(finalBulletCircle, playerRect)) {
                            p.hp -= 1; // 1 hit to die
                            room.bullets.splice(i, 1);
                            
                            if (p.hp <= 0) {
                                // Grant score to killer
                                if (room.players[b.owner] && b.owner !== pid) {
                                    room.players[b.owner].score += 1;
                                }
                                io.to(code).emit('playerDied', { victim: pid, killer: b.owner });
                                
                                room.status = 'round_over';
                                setTimeout(() => {
                                    if (rooms[code]) {
                                        rooms[code].status = 'playing';
                                        startNewRound(rooms[code], code);
                                    }
                                }, 3000);
                            }
                            break;
                        }
                    }
                }
            }

            // server.js içindeki io.to(code).emit('gameState', ...) kısmını bununla değiştir:
            io.to(code).emit('gameState', {
                players: Object.values(room.players).map(p => ({
                    id: p.id,
                    x: p.x,
                    y: p.y,
                    angle: p.angle,
                    hp: p.hp,
                    color: p.color
                })),
                bullets: room.bullets.map(b => ({
                    x: b.x,
                    y: b.y
                }))
            });
        }
    }
}, 1000 / 30); // 30 FPS

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
