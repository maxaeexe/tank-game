const socket = io({ transports: ['websocket'] });

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

let inputState = {
    up: false,
    angle: 0,
    isShooting: false
};

let camera = { x: 0, y: 0, zoom: 20 }; // zoom is pixels per unit

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
    
    deathScreen.classList.add('hidden');

    if (!gameState.playing) {
        gameState.playing = true;
        lobbyMenu.classList.remove('active');
        document.getElementById('ui-layer').style.pointerEvents = 'none'; // allow canvas interaction
        gameUi.classList.remove('hidden');
        canvas.style.display = 'block';
        
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        
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

// Send input to server at a fixed interval
setInterval(() => {
    if (gameState.playing) {
        socket.emit('playerInput', inputState);
    }
}, 1000 / 30);

// --- Game State Update ---

socket.on('gameState', (data) => {
    if (!gameState.playing) return;
    gameState.players = data.players;
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

    // Update Score UI
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
});

socket.on('playerDied', (data) => {
    if (data.victim === myId && deathScreen.classList.contains('hidden')) {
        deathScreen.classList.remove('hidden');
        respawnTimerText.innerText = 'WAIT FOR NEXT ROUND';
    }
});

// --- Rendering ---

function drawGrid() {
    const s = gameState.mapData.size * camera.zoom;
    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;

    // Draw floor background
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(startX, startY, s, s);

    ctx.strokeStyle = '#d0d0d0';
    ctx.lineWidth = 1;

    // Draw grid lines
    const cellSize = 10 * camera.zoom;
    for (let x = 0; x <= s; x += cellSize) {
        ctx.beginPath();
        ctx.moveTo(startX + x, startY);
        ctx.lineTo(startX + x, startY + s);
        ctx.stroke();
    }
    for (let y = 0; y <= s; y += cellSize) {
        ctx.beginPath();
        ctx.moveTo(startX, startY + y);
        ctx.lineTo(startX + s, startY + y);
        ctx.stroke();
    }
}

function drawMap() {
    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;

    // Outer boundary
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 4;
    ctx.strokeRect(startX, startY, gameState.mapData.size * camera.zoom, gameState.mapData.size * camera.zoom);

    // Walls
    ctx.fillStyle = '#666';
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 2;
    
    gameState.mapData.walls.forEach(wall => {
        // Skip boundary walls for drawing, we drew a big box
        if (wall.isBoundary) return;

        const wx = startX + wall.x * camera.zoom;
        const wy = startY + wall.y * camera.zoom;
        const ww = wall.width * camera.zoom;
        const wh = wall.height * camera.zoom;

        ctx.fillRect(wx, wy, ww, wh);
        ctx.strokeRect(wx, wy, ww, wh);
    });
}

function drawPlayers() {
    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;
    const playerSize = 2 * camera.zoom; // width/height
    const radius = playerSize / 2;

    for (let id in gameState.players) {
        const p = gameState.players[id];
        if (p.hp <= 0) continue;

        const px = startX + p.x * camera.zoom;
        const py = startY + p.y * camera.zoom;

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

    ctx.fillStyle = '#fff';
    
    gameState.bullets.forEach(b => {
        const bx = startX + b.x * camera.zoom;
        const by = startY + b.y * camera.zoom;
        
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(bx, by, 0.2 * camera.zoom, 0, Math.PI * 2);
        ctx.fill();
    });
}

function gameLoop() {
    if (!gameState.playing) return;

    // Smooth camera follow
    const myPlayer = gameState.players[myId];
    if (myPlayer) {
        camera.x += (myPlayer.x - camera.x) * 0.1;
        camera.y += (myPlayer.y - camera.y) * 0.1;
    } else if (gameState.mapData) {
        camera.x = gameState.mapData.size / 2;
        camera.y = gameState.mapData.size / 2;
    }

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawGrid();
    drawMap();
    drawBullets();
    drawPlayers();

    requestAnimationFrame(gameLoop);
}
