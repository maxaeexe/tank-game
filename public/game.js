const socket = io({ transports: ['websocket', 'polling'] });

// UI Elements
const mainMenu = document.getElementById('main-menu');
const lobbyMenu = document.getElementById('lobby-menu');
const gameUi = document.getElementById('game-ui');
const deathScreen = document.getElementById('death-screen');

const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const btnStart = document.getElementById('btn-start');
const roomCodeInput = document.getElementById('room-code-input');
const errorMsg = document.getElementById('error-msg');
const modeSelect = document.getElementById('mode-select');

const displayRoomCode = document.getElementById('display-room-code');
const playersList = document.getElementById('players-list');
const playerCountSpan = document.getElementById('player-count');
const colorPicker = document.getElementById('color-picker');
const previewTankBody = document.getElementById('preview-tank-body');
const waitingMsg = document.getElementById('waiting-msg');

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const hpValue = document.getElementById('hp-value');
const hpBar = document.getElementById('hp-bar');
const gameRoomCodeDisplay = document.getElementById('game-room-code');
const respawnTimerText = document.getElementById('respawn-timer');

// Constants
const availableColors = ["#FF5733", "#33FF57", "#3357FF", "#F1C40F", "#9B59B6", "#1ABC9C", "#E67E22", "#E74C3C"];
let myId = null;
let isHost = false;
let myColor = null;

// Game State
let gameState = {
    playing: false,
    mapData: null,
    players: {},
    bullets: []
};

// ===== INTERPOLATION STATE =====
let prevGameState = null;  // Previous server state
let currGameState = null;  // Current server state
let stateTimestamp = 0;    // When we received current state
let prevTimestamp = 0;     // When we received previous state

let inputState = {
    up: false,
    angle: 0,
    isShooting: false
};

// Track if input changed to avoid sending duplicate data
let lastSentInput = { up: false, angle: 0, isShooting: false };

let camera = { x: 0, y: 0, zoom: 20 }; // zoom is pixels per unit

// ===== OFFSCREEN MAP CACHE =====
let mapCache = null;       // OffscreenCanvas for static map elements
let mapCacheDirty = true;  // Whether we need to redraw the cache

// --- Main Menu ---

btnCreate.addEventListener('click', () => {
    socket.emit('createRoom', { mode: modeSelect.value });
});

btnJoin.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (code.length === 5) {
        socket.emit('joinRoom', code);
    } else {
        showError('Invalid room code format.');
    }
});

socket.on('errorMsg', (msg) => {
    showError(msg);
});

function showError(msg) {
    errorMsg.innerText = msg;
    setTimeout(() => errorMsg.innerText = '', 3000);
}

// --- Lobby ---

socket.on('joined', (data) => {
    myId = data.id;
    isHost = data.isHost;
    
    mainMenu.classList.remove('active');
    lobbyMenu.classList.add('active');
    
    displayRoomCode.innerText = data.code;
    gameRoomCodeDisplay.innerText = data.code;

    if (isHost) {
        btnStart.style.display = 'block';
        waitingMsg.style.display = 'none';
    } else {
        btnStart.style.display = 'none';
        waitingMsg.style.display = 'block';
    }
    
    renderColorPicker();
});

socket.on('updateLobby', (players) => {
    playersList.innerHTML = '';
    playerCountSpan.innerText = `${players.length}/8`;

    const usedColors = players.map(p => p.color);
    
    // Update color picker UI
    Array.from(colorPicker.children).forEach(btn => {
        const c = btn.dataset.color;
        btn.classList.remove('disabled');
        btn.classList.remove('active');
        
        if (usedColors.includes(c)) {
            const playerUsingIt = players.find(p => p.color === c);
            if (playerUsingIt.id !== myId) {
                btn.classList.add('disabled');
            } else {
                btn.classList.add('active');
                myColor = c;
                previewTankBody.style.backgroundColor = c;
                previewTankBody.style.boxShadow = `0 0 15px ${c}`;
            }
        }
    });

    players.forEach(p => {
        const li = document.createElement('li');
        li.className = 'player-item';
        
        const colorIndicator = document.createElement('div');
        colorIndicator.className = 'color-indicator';
        colorIndicator.style.color = p.color;
        colorIndicator.style.backgroundColor = p.color;
        
        const nameText = document.createElement('span');
        nameText.innerText = p.name + (p.isHost ? ' (Host)' : '') + (p.id === myId ? ' (You)' : '');
        
        li.appendChild(colorIndicator);
        li.appendChild(nameText);
        playersList.appendChild(li);
    });
});

function renderColorPicker() {
    colorPicker.innerHTML = '';
    availableColors.forEach(color => {
        const btn = document.createElement('div');
        btn.className = 'color-btn';
        btn.style.backgroundColor = color;
        btn.dataset.color = color;
        
        btn.addEventListener('click', () => {
            if (!btn.classList.contains('disabled')) {
                socket.emit('changeColor', color);
            }
        });
        
        colorPicker.appendChild(btn);
    });
}

btnStart.addEventListener('click', () => {
    socket.emit('startGame');
});

// --- Game Initialization ---

socket.on('newRound', (data) => {
    gameState.mapData = data.mapData;
    gameState.players = data.players;
    gameState.bullets = [];
    
    // Reset interpolation state
    prevGameState = null;
    currGameState = null;
    
    // Mark map cache as dirty — needs redraw
    mapCacheDirty = true;
    
    deathScreen.classList.add('hidden');

    if (!gameState.playing) {
        gameState.playing = true;
        lobbyMenu.classList.remove('active');
        document.getElementById('ui-layer').style.pointerEvents = 'none'; // allow canvas interaction
        gameUi.classList.remove('hidden');
        canvas.style.display = 'block';
        
        resizeCanvas();
        window.addEventListener('resize', () => {
            resizeCanvas();
            mapCacheDirty = true; // resize invalidates cache
        });
        
        // Start local loop
        requestAnimationFrame(gameLoop);
    }
});

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}

// --- Input Handling ---

window.addEventListener('keydown', (e) => {
    if (!gameState.playing) return;
    if (e.key.toLowerCase() === 'w') inputState.up = true;
});

window.addEventListener('keyup', (e) => {
    if (!gameState.playing) return;
    if (e.key.toLowerCase() === 'w') inputState.up = false;
});

canvas.addEventListener('mousemove', (e) => {
    if (!gameState.playing || !gameState.players[myId]) return;
    
    const myPlayer = gameState.players[myId];
    // We need to find angle from player center on screen to mouse
    // Player is drawn at camera center roughly, but exact screen coords:
    const screenX = canvas.width / 2 + (myPlayer.x - camera.x) * camera.zoom;
    const screenY = canvas.height / 2 + (myPlayer.y - camera.y) * camera.zoom;
    
    const dx = e.clientX - screenX;
    const dy = e.clientY - screenY;
    inputState.angle = Math.atan2(dy, dx);
});

canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) inputState.isShooting = true;
});

canvas.addEventListener('mouseup', (e) => {
    if (e.button === 0) inputState.isShooting = false;
});

// Send input to server — only when changed or shooting, at reduced rate
setInterval(() => {
    if (gameState.playing) {
        // Always send if shooting (server needs continuous signal)
        // Otherwise, only send when input actually changed
        const angleChanged = Math.abs(inputState.angle - lastSentInput.angle) > 0.02;
        const movementChanged = inputState.up !== lastSentInput.up;
        const shootingChanged = inputState.isShooting !== lastSentInput.isShooting;

        if (angleChanged || movementChanged || shootingChanged || inputState.isShooting || inputState.up) {
            socket.emit('playerInput', inputState);
            lastSentInput.up = inputState.up;
            lastSentInput.angle = inputState.angle;
            lastSentInput.isShooting = inputState.isShooting;
        }
    }
}, 1000 / 20); // Match server tick rate (20)

// --- Game State Update ---

socket.on('gameState', (data) => {
    if (!gameState.playing) return;

    // Unpack compact keys back to full names
    const expandedPlayers = {};
    for (let pid in data.players) {
        const p = data.players[pid];
        expandedPlayers[pid] = {
            id: p.id,
            name: p.n,
            x: p.x,
            y: p.y,
            angle: p.a,
            hp: p.hp,
            score: p.s,
            color: p.c
        };
    }

    // Store previous state for interpolation
    prevGameState = currGameState;
    prevTimestamp = stateTimestamp;
    currGameState = { players: expandedPlayers, bullets: data.bullets };
    stateTimestamp = performance.now();

    // Update authoritative state
    gameState.players = expandedPlayers;
    gameState.bullets = data.bullets;

    const myPlayer = gameState.players[myId];
    if (myPlayer) {
        // Update HP UI
        hpValue.innerText = Math.max(0, myPlayer.hp);
        
        if (myPlayer.hp <= 0 && deathScreen.classList.contains('hidden')) {
            deathScreen.classList.remove('hidden');
            respawnTimerText.innerText = 'WAIT FOR NEXT ROUND';
        }
    }

    // Update Score UI — throttled, not every frame
    updateScoreUI();
});

// Throttle score UI updates
let lastScoreUpdate = 0;
function updateScoreUI() {
    const now = performance.now();
    if (now - lastScoreUpdate < 500) return; // Update at most every 500ms
    lastScoreUpdate = now;

    const scoreList = document.getElementById('score-list');
    if (scoreList) {
        scoreList.innerHTML = '';
        Object.values(gameState.players)
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .forEach(p => {
                const li = document.createElement('li');
                li.style.color = p.color;
                li.innerText = `${p.name}: ${p.score || 0}`;
                scoreList.appendChild(li);
            });
    }
}

socket.on('playerDied', (data) => {
    if (data.victim === myId && deathScreen.classList.contains('hidden')) {
        deathScreen.classList.remove('hidden');
        respawnTimerText.innerText = 'WAIT FOR NEXT ROUND';
    }
});

// --- Rendering ---

// Build offscreen map cache (grid + walls) — only redrawn when map changes
function buildMapCache() {
    if (!gameState.mapData) return;

    const mapSize = gameState.mapData.size;
    const cacheW = mapSize * camera.zoom;
    const cacheH = mapSize * camera.zoom;

    // Create offscreen canvas for map
    mapCache = document.createElement('canvas');
    mapCache.width = cacheW;
    mapCache.height = cacheH;
    const mctx = mapCache.getContext('2d');

    // Draw floor background
    mctx.fillStyle = '#e0e0e0';
    mctx.fillRect(0, 0, cacheW, cacheH);

    // Draw grid lines
    mctx.strokeStyle = '#d0d0d0';
    mctx.lineWidth = 1;
    const cellSize = 10 * camera.zoom;
    for (let x = 0; x <= cacheW; x += cellSize) {
        mctx.beginPath();
        mctx.moveTo(x, 0);
        mctx.lineTo(x, cacheH);
        mctx.stroke();
    }
    for (let y = 0; y <= cacheH; y += cellSize) {
        mctx.beginPath();
        mctx.moveTo(0, y);
        mctx.lineTo(cacheW, y);
        mctx.stroke();
    }

    // Draw walls
    mctx.fillStyle = '#666';
    mctx.strokeStyle = '#444';
    mctx.lineWidth = 2;
    
    const walls = gameState.mapData.walls;
    for (let i = 0; i < walls.length; i++) {
        const wall = walls[i];
        if (wall.isBoundary) continue;

        const wx = wall.x * camera.zoom;
        const wy = wall.y * camera.zoom;
        const ww = wall.width * camera.zoom;
        const wh = wall.height * camera.zoom;

        mctx.fillRect(wx, wy, ww, wh);
        mctx.strokeRect(wx, wy, ww, wh);
    }

    // Draw outer boundary
    mctx.strokeStyle = '#555';
    mctx.lineWidth = 4;
    mctx.strokeRect(0, 0, cacheW, cacheH);

    mapCacheDirty = false;
}

function drawCachedMap() {
    if (!mapCache) return;

    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;

    // Only draw the visible portion (viewport culling)
    const srcX = Math.max(0, -startX);
    const srcY = Math.max(0, -startY);
    const srcW = Math.min(mapCache.width - srcX, canvas.width - Math.max(0, startX));
    const srcH = Math.min(mapCache.height - srcY, canvas.height - Math.max(0, startY));

    if (srcW <= 0 || srcH <= 0) return;

    const destX = Math.max(0, startX) + srcX - Math.max(0, -startX + srcX);
    const destY = Math.max(0, startY) + srcY - Math.max(0, -startY + srcY);

    // Simpler approach: just drawImage with clipping
    ctx.drawImage(mapCache, 
        srcX, srcY, srcW, srcH,
        Math.max(0, startX), Math.max(0, startY), srcW, srcH
    );
}

// Interpolate a value between prev and curr
function lerp(a, b, t) {
    return a + (b - a) * t;
}

// Interpolate angle (handle wrapping)
function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}

function getInterpolatedPlayers() {
    if (!prevGameState || !currGameState) return gameState.players;

    const serverTickMs = 50; // 1000/20 = 50ms between ticks
    const elapsed = performance.now() - stateTimestamp;
    const t = Math.min(elapsed / serverTickMs, 1.0);

    const result = {};
    for (let pid in currGameState.players) {
        const curr = currGameState.players[pid];
        const prev = prevGameState.players[pid];

        if (prev) {
            result[pid] = {
                ...curr,
                x: lerp(prev.x, curr.x, t),
                y: lerp(prev.y, curr.y, t),
                angle: lerpAngle(prev.angle, curr.angle, t)
            };
        } else {
            result[pid] = curr;
        }
    }
    return result;
}

function drawPlayers(interpolatedPlayers) {
    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;
    const playerSize = 2 * camera.zoom; // width/height
    const radius = playerSize / 2;

    // Viewport bounds for culling
    const vpLeft = -radius * 2;
    const vpRight = canvas.width + radius * 2;
    const vpTop = -radius * 2;
    const vpBottom = canvas.height + radius * 2;

    for (let id in interpolatedPlayers) {
        const p = interpolatedPlayers[id];
        if (p.hp <= 0) continue;

        const px = startX + p.x * camera.zoom;
        const py = startY + p.y * camera.zoom;

        // Viewport culling — skip off-screen players
        if (px < vpLeft || px > vpRight || py < vpTop || py > vpBottom) continue;

        ctx.save();
        ctx.translate(px, py);

        // Name tag
        ctx.fillStyle = '#000';
        ctx.font = '10px "Press Start 2P"';
        ctx.textAlign = 'center';
        ctx.fillText(p.name, 0, -radius - 15);

        // Tank rotation
        ctx.rotate(p.angle);
        
        // Base body
        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 2;

        ctx.fillRect(-radius, -radius, playerSize, playerSize);
        ctx.strokeRect(-radius, -radius, playerSize, playerSize);
        
        // Turret barrel
        ctx.fillStyle = '#999';
        ctx.fillRect(0, -radius * 0.3, radius + 10, radius * 0.6);
        ctx.strokeRect(0, -radius * 0.3, radius + 10, radius * 0.6);
        
        // Turret center
        ctx.fillStyle = '#666';
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.restore();
    }
}

function drawBullets() {
    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;
    const bulletScreenR = 0.2 * camera.zoom;

    // Viewport bounds for culling
    const vpLeft = -bulletScreenR;
    const vpRight = canvas.width + bulletScreenR;
    const vpTop = -bulletScreenR;
    const vpBottom = canvas.height + bulletScreenR;

    ctx.fillStyle = '#000';

    const bullets = gameState.bullets;
    for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        const bx = startX + b.x * camera.zoom;
        const by = startY + b.y * camera.zoom;

        // Viewport culling
        if (bx < vpLeft || bx > vpRight || by < vpTop || by > vpBottom) continue;
        
        ctx.beginPath();
        ctx.arc(bx, by, bulletScreenR, 0, Math.PI * 2);
        ctx.fill();
    }
}

function gameLoop() {
    if (!gameState.playing) return;

    // Rebuild map cache if needed
    if (mapCacheDirty && gameState.mapData) {
        buildMapCache();
    }

    // Get interpolated player positions
    const interpolatedPlayers = getInterpolatedPlayers();

    // Smooth camera follow using interpolated position
    const myPlayer = interpolatedPlayers[myId] || gameState.players[myId];
    if (myPlayer) {
        camera.x += (myPlayer.x - camera.x) * 0.1;
        camera.y += (myPlayer.y - camera.y) * 0.1;
    } else if (gameState.mapData) {
        camera.x = gameState.mapData.size / 2;
        camera.y = gameState.mapData.size / 2;
    }

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw cached map (grid + walls in one drawImage call)
    drawCachedMap();

    drawBullets();
    drawPlayers(interpolatedPlayers);

    requestAnimationFrame(gameLoop);
}
