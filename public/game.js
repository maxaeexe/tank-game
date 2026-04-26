// Sunucunuz farklı bir domain'deyse (örneğin Vercel ve Render), adresi buraya yazmalısınız:
// const socket = io("https://sizin-backend-url.com", { transports: ['polling', 'websocket'] });
const socket = io({ transports: ['polling', 'websocket'] });


// UI Elements
const mainMenu = document.getElementById('main-menu');
const lobbyMenu = document.getElementById('lobby-menu');
const gameUi = document.getElementById('game-ui');
const deathScreen = document.getElementById('death-screen');

const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const btnStart = document.getElementById('btn-start');
const roomCodeInput = document.getElementById('room-code-input');
const usernameInput = document.getElementById('username-input');
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

// Chat elements
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');

// Spectate elements
const spectateBar = document.getElementById('spectate-bar');
const spectateName = document.getElementById('spectate-name');
const spectatePrev = document.getElementById('spectate-prev');
const spectateNext = document.getElementById('spectate-next');

// Constants
const availableColors = ["#FF5733", "#33FF57", "#3357FF", "#F1C40F", "#9B59B6", "#1ABC9C", "#E67E22", "#E74C3C"];
let myId = null;
let isHost = false;
let myColor = null;
let roomMode = 'ffa'; // 'ffa' or 'team'
let roomTeamSize = 2;

// Game State
let gameState = {
    playing: false,
    mapData: null,
    players: {},
    bullets: []
};

// ===== INTERPOLATION STATE =====
let prevGameState = null;
let currGameState = null;
let stateTimestamp = 0;
let prevTimestamp = 0;

let inputState = {
    up: false,
    down: false,
    left: false,
    right: false,
    angle: 0,
    isShooting: false
};

let lastSentInput = { up: false, down: false, left: false, right: false, angle: 0, isShooting: false };

let camera = { x: 0, y: 0, zoom: 20 };

// ===== OFFSCREEN MAP CACHE =====
let mapCache = null;
let mapCacheDirty = true;

// ===== SPECTATE STATE =====
let isSpectating = false;
let spectateTargetId = null;
let chatFocused = false;

// --- Username Validation ---

function getUsername() {
    const name = usernameInput.value.trim();
    if (!name || name.length < 1) {
        usernameInput.classList.add('error');
        usernameInput.focus();
        showError('Lütfen bir kullanıcı adı girin!');
        setTimeout(() => usernameInput.classList.remove('error'), 600);
        return null;
    }
    return name;
}

// --- Main Menu ---

btnCreate.addEventListener('click', () => {
    const username = getUsername();
    if (!username) return;
    socket.emit('createRoom', { mode: modeSelect.value, username });
});

btnJoin.addEventListener('click', () => {
    const username = getUsername();
    if (!username) return;
    const code = roomCodeInput.value.trim().toUpperCase();
    if (code.length === 5) {
        socket.emit('joinRoom', { code, username });
    } else {
        showError('Geçersiz oda kodu formatı.');
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
    roomMode = data.mode || 'ffa';
    roomTeamSize = data.teamSize || 2;

    mainMenu.classList.remove('active');
    lobbyMenu.classList.add('active');

    displayRoomCode.innerText = data.code;
    gameRoomCodeDisplay.innerText = data.code;

    // Show mode label
    const lobbyModeLabel = document.getElementById('lobby-mode-label');
    lobbyModeLabel.innerText = roomMode === 'team' ? 'TEAM DEATHMATCH' : 'FREE FOR ALL';

    // Toggle lobby views based on mode
    const ffaContent = document.getElementById('ffa-lobby-content');
    const teamContent = document.getElementById('team-lobby-content');
    const teamSizeSelector = document.getElementById('team-size-selector');

    if (roomMode === 'team') {
        ffaContent.style.display = 'none';
        teamContent.style.display = 'flex';
        lobbyMenu.classList.add('team-lobby');

        if (isHost) {
            teamSizeSelector.style.display = 'flex';
            document.getElementById('team-size-select').value = String(roomTeamSize);
        } else {
            teamSizeSelector.style.display = 'none';
        }
    } else {
        ffaContent.style.display = 'flex';
        teamContent.style.display = 'none';
        teamSizeSelector.style.display = 'none';
        lobbyMenu.classList.remove('team-lobby');
        renderColorPicker();
    }

    if (isHost) {
        btnStart.style.display = 'block';
        waitingMsg.style.display = 'none';
    } else {
        btnStart.style.display = 'none';
        waitingMsg.style.display = 'block';
    }
});

// --- Mid-Game Join ---
socket.on('joinedMidGame', (data) => {
    myId = data.id;
    isHost = false;
    roomMode = data.mode || 'ffa';

    gameRoomCodeDisplay.innerText = data.code;

    // Set up game state immediately
    gameState.mapData = data.mapData;
    gameState.players = data.players;
    gameState.bullets = [];
    mapCacheDirty = true;

    // Update team scores if available
    if (data.teamScores) {
        const teamAScoreEl = document.getElementById('team-a-score-val');
        const teamBScoreEl = document.getElementById('team-b-score-val');
        if (teamAScoreEl) teamAScoreEl.innerText = data.teamScores.A;
        if (teamBScoreEl) teamBScoreEl.innerText = data.teamScores.B;
    }

    // Load chat history
    if (data.chatHistory) {
        data.chatHistory.forEach(msg => addChatMessage(msg));
    }

    // Enter spectate mode immediately
    isSpectating = true;
    enterSpectateMode();

    if (!gameState.playing) {
        gameState.playing = true;
        mainMenu.classList.remove('active');
        lobbyMenu.classList.remove('active');
        document.getElementById('ui-layer').style.pointerEvents = 'none';
        gameUi.classList.remove('hidden');
        canvas.style.display = 'block';

        resizeCanvas();
        window.addEventListener('resize', () => {
            resizeCanvas();
            mapCacheDirty = true;
        });

        // Show death screen for spectators
        deathScreen.classList.remove('hidden');
        respawnTimerText.innerText = 'WAITING FOR NEXT ROUND';

        requestAnimationFrame(gameLoop);
    }
});

socket.on('updateLobby', (data) => {
    // data is now an object with players, mode, teamSize, teamScores
    const players = data.players || data;
    const mode = data.mode || roomMode;
    const teamSize = data.teamSize || roomTeamSize;
    roomMode = mode;
    roomTeamSize = teamSize;

    if (mode === 'team') {
        renderTeamLobby(players, teamSize);
    } else {
        renderFFALobby(players);
    }
});

function renderFFALobby(players) {
    playersList.innerHTML = '';
    playerCountSpan.innerText = `${players.length}/8`;

    const usedColors = players.map(p => p.color);

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
}

function renderTeamLobby(players, teamSize) {
    const teamAList = document.getElementById('team-a-list');
    const teamBList = document.getElementById('team-b-list');
    const btnJoinA = document.getElementById('btn-join-team-a');
    const btnJoinB = document.getElementById('btn-join-team-b');

    teamAList.innerHTML = '';
    teamBList.innerHTML = '';

    const teamAPlayers = players.filter(p => p.team === 'A');
    const teamBPlayers = players.filter(p => p.team === 'B');

    // Update team size selector if host
    if (isHost) {
        const selector = document.getElementById('team-size-select');
        if (selector.value !== String(teamSize)) {
            selector.value = String(teamSize);
        }
    }

    // Render Team A players
    teamAPlayers.forEach(p => {
        const li = document.createElement('li');
        li.className = 'team-player-item';

        const dot = document.createElement('div');
        dot.className = 'team-color-dot';
        dot.style.backgroundColor = '#e74c3c';

        const nameText = document.createElement('span');
        nameText.innerText = p.name + (p.isHost ? ' (Host)' : '') + (p.id === myId ? ' (You)' : '');

        li.appendChild(dot);
        li.appendChild(nameText);
        teamAList.appendChild(li);
    });

    // Render Team B players
    teamBPlayers.forEach(p => {
        const li = document.createElement('li');
        li.className = 'team-player-item';

        const dot = document.createElement('div');
        dot.className = 'team-color-dot';
        dot.style.backgroundColor = '#3498db';

        const nameText = document.createElement('span');
        nameText.innerText = p.name + (p.isHost ? ' (Host)' : '') + (p.id === myId ? ' (You)' : '');

        li.appendChild(dot);
        li.appendChild(nameText);
        teamBList.appendChild(li);
    });

    // Update join buttons
    const myPlayer = players.find(p => p.id === myId);
    btnJoinA.classList.toggle('active-team', myPlayer && myPlayer.team === 'A');
    btnJoinB.classList.toggle('active-team', myPlayer && myPlayer.team === 'B');

    btnJoinA.innerText = `JOIN TEAM A (${teamAPlayers.length}/${teamSize})`;
    btnJoinB.innerText = `JOIN TEAM B (${teamBPlayers.length}/${teamSize})`;

    if (teamAPlayers.length >= teamSize && (!myPlayer || myPlayer.team !== 'A')) {
        btnJoinA.disabled = true;
        btnJoinA.style.opacity = '0.5';
    } else {
        btnJoinA.disabled = false;
        btnJoinA.style.opacity = '1';
    }

    if (teamBPlayers.length >= teamSize && (!myPlayer || myPlayer.team !== 'B')) {
        btnJoinB.disabled = true;
        btnJoinB.style.opacity = '0.5';
    } else {
        btnJoinB.disabled = false;
        btnJoinB.style.opacity = '1';
    }
}

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

// Team switching buttons
document.getElementById('btn-join-team-a').addEventListener('click', () => {
    socket.emit('switchTeam', 'A');
});

document.getElementById('btn-join-team-b').addEventListener('click', () => {
    socket.emit('switchTeam', 'B');
});

// Team size change (host only)
document.getElementById('team-size-select').addEventListener('change', (e) => {
    socket.emit('setTeamSize', parseInt(e.target.value));
});

// --- Game Initialization ---

socket.on('newRound', (data) => {
    gameState.mapData = data.mapData;
    gameState.players = data.players;
    gameState.bullets = [];

    prevGameState = null;
    currGameState = null;
    mapCacheDirty = true;

    // Reset spectate & death state
    isSpectating = false;
    spectateTargetId = null;
    spectateBar.classList.add('hidden');
    deathScreen.classList.add('hidden');

    if (!gameState.playing) {
        gameState.playing = true;
        lobbyMenu.classList.remove('active');
        document.getElementById('ui-layer').style.pointerEvents = 'none';
        gameUi.classList.remove('hidden');
        canvas.style.display = 'block';

        resizeCanvas();
        window.addEventListener('resize', () => {
            resizeCanvas();
            mapCacheDirty = true;
        });

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
    if (chatFocused) return; // Don't handle game input when typing in chat

    const key = e.key.toLowerCase();
    if (key === 'w') inputState.up = true;
    if (key === 'a') inputState.left = true;
    if (key === 's') inputState.down = true;
    if (key === 'd') inputState.right = true;

    // Spectate: arrow keys to switch targets
    if (isSpectating) {
        if (e.key === 'ArrowLeft') cycleSpectate(-1);
        if (e.key === 'ArrowRight') cycleSpectate(1);
    }
});

window.addEventListener('keyup', (e) => {
    if (!gameState.playing) return;
    
    const key = e.key.toLowerCase();
    if (key === 'w') inputState.up = false;
    if (key === 'a') inputState.left = false;
    if (key === 's') inputState.down = false;
    if (key === 'd') inputState.right = false;
});

canvas.addEventListener('mousemove', (e) => {
    if (!gameState.playing || !gameState.players[myId]) return;

    const myPlayer = gameState.players[myId];
    if (myPlayer.hp <= 0) return; // Don't update angle when dead

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

// Send input to server
setInterval(() => {
    if (gameState.playing && !isSpectating) {
        const angleChanged = Math.abs(inputState.angle - lastSentInput.angle) > 0.02;
        const movementChanged = inputState.up !== lastSentInput.up ||
                                inputState.down !== lastSentInput.down ||
                                inputState.left !== lastSentInput.left ||
                                inputState.right !== lastSentInput.right;
        const shootingChanged = inputState.isShooting !== lastSentInput.isShooting;

        if (angleChanged || movementChanged || shootingChanged || 
            inputState.isShooting || inputState.up || inputState.down || inputState.left || inputState.right) {
            socket.emit('playerInput', inputState);
            lastSentInput.up = inputState.up;
            lastSentInput.down = inputState.down;
            lastSentInput.left = inputState.left;
            lastSentInput.right = inputState.right;
            lastSentInput.angle = inputState.angle;
            lastSentInput.isShooting = inputState.isShooting;
        }
    }
}, 1000 / 20);

// --- Chat ---

chatInput.addEventListener('focus', () => {
    chatFocused = true;
});

chatInput.addEventListener('blur', () => {
    chatFocused = false;
});

chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // Prevent game keys from firing

    if (e.key === 'Enter') {
        const text = chatInput.value.trim();
        if (text) {
            socket.emit('chatMessage', text);
            chatInput.value = '';
        }
        chatInput.blur();
    }
    if (e.key === 'Escape') {
        chatInput.blur();
    }
});

// Global Enter key to focus chat
window.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && gameState.playing && !chatFocused) {
        e.preventDefault();
        chatInput.focus();
    }
});

socket.on('chatMessage', (msg) => {
    addChatMessage(msg);
});

function addChatMessage(msg) {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (msg.type === 'system' ? ' system' : '');

    if (msg.type === 'system') {
        div.textContent = msg.text;
    } else {
        const sender = document.createElement('span');
        sender.className = 'chat-sender';
        sender.style.color = msg.color || '#fff';
        sender.textContent = msg.sender + ':';

        const text = document.createElement('span');
        text.className = 'chat-text';
        text.textContent = ' ' + msg.text;

        div.appendChild(sender);
        div.appendChild(text);
    }

    chatMessages.appendChild(div);

    // Limit to 50 visible messages
    while (chatMessages.children.length > 50) {
        chatMessages.removeChild(chatMessages.firstChild);
    }

    // Auto-scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Spectate ---

function enterSpectateMode() {
    isSpectating = true;

    // Find first alive player to spectate
    const alivePlayers = getAlivePlayers();
    if (alivePlayers.length > 0) {
        spectateTargetId = alivePlayers[0].id;
        updateSpectateUI();
        spectateBar.classList.remove('hidden');
    } else {
        spectateTargetId = null;
        spectateBar.classList.add('hidden');
    }
}

function getAlivePlayers() {
    return Object.values(gameState.players).filter(p => p.hp > 0 && p.id !== myId);
}

function cycleSpectate(direction) {
    const alivePlayers = getAlivePlayers();
    if (alivePlayers.length === 0) {
        spectateTargetId = null;
        spectateBar.classList.add('hidden');
        return;
    }

    let currentIndex = alivePlayers.findIndex(p => p.id === spectateTargetId);
    if (currentIndex === -1) currentIndex = 0;

    currentIndex = (currentIndex + direction + alivePlayers.length) % alivePlayers.length;
    spectateTargetId = alivePlayers[currentIndex].id;
    updateSpectateUI();
}

function updateSpectateUI() {
    if (spectateTargetId && gameState.players[spectateTargetId]) {
        const target = gameState.players[spectateTargetId];
        spectateName.textContent = '👁 ' + target.name;
        spectateName.style.color = target.color || '#FFD700';
        spectateBar.classList.remove('hidden');
    } else {
        spectateBar.classList.add('hidden');
    }
}

spectatePrev.addEventListener('click', () => cycleSpectate(-1));
spectateNext.addEventListener('click', () => cycleSpectate(1));

// --- Game State Update ---

socket.on('gameState', (data) => {
    if (!gameState.playing) return;

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
            color: p.c,
            team: p.t || null
        };
    }

    // Track game mode
    if (data.mode) roomMode = data.mode;

    // Update team scores from server tick
    if (data.teamScores) {
        const teamAScoreEl = document.getElementById('team-a-score-val');
        const teamBScoreEl = document.getElementById('team-b-score-val');
        if (teamAScoreEl) teamAScoreEl.innerText = data.teamScores.A;
        if (teamBScoreEl) teamBScoreEl.innerText = data.teamScores.B;
    }

    prevGameState = currGameState;
    prevTimestamp = stateTimestamp;
    currGameState = { players: expandedPlayers, bullets: data.bullets };
    stateTimestamp = performance.now();

    gameState.players = expandedPlayers;
    gameState.bullets = data.bullets;

    const myPlayer = gameState.players[myId];
    if (myPlayer) {
        hpValue.innerText = Math.max(0, myPlayer.hp);

        if (myPlayer.hp <= 0 && !isSpectating) {
            // Player just died — enter spectate mode
            isSpectating = true;
            deathScreen.classList.remove('hidden');
            respawnTimerText.innerText = 'WAITING FOR NEXT ROUND';
            enterSpectateMode();
        }
    }

    // Update spectate UI if target died
    if (isSpectating && spectateTargetId) {
        const target = gameState.players[spectateTargetId];
        if (!target || target.hp <= 0) {
            // Target died, switch to next alive player
            cycleSpectate(1);
        }
    }

    updateScoreUI();
});

// Throttle score UI updates
let lastScoreUpdate = 0;
function updateScoreUI() {
    const now = performance.now();
    if (now - lastScoreUpdate < 500) return;
    lastScoreUpdate = now;

    const scoreList = document.getElementById('score-list');
    const teamScoreDisplay = document.getElementById('team-score-display');

    if (roomMode === 'team') {
        // Team mode: show team scores
        if (scoreList) scoreList.innerHTML = '';
        if (scoreList) scoreList.style.display = 'none';
        if (teamScoreDisplay) teamScoreDisplay.style.display = 'flex';
    } else {
        // FFA mode: show individual scores
        if (teamScoreDisplay) teamScoreDisplay.style.display = 'none';
        if (scoreList) scoreList.style.display = 'block';
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
}

socket.on('playerDied', (data) => {
    if (data.victim === myId && !isSpectating) {
        isSpectating = true;
        deathScreen.classList.remove('hidden');
        respawnTimerText.innerText = 'WAITING FOR NEXT ROUND';
        enterSpectateMode();
    }
});

socket.on('roundWinner', (data) => {
    // Update team scores if available
    if (data.teamScores) {
        const teamAScoreEl = document.getElementById('team-a-score-val');
        const teamBScoreEl = document.getElementById('team-b-score-val');
        if (teamAScoreEl) teamAScoreEl.innerText = data.teamScores.A;
        if (teamBScoreEl) teamBScoreEl.innerText = data.teamScores.B;
    }

    addChatMessage({
        type: 'system',
        text: `🏆 ${data.name} roundu kazandı!`
    });
});

// --- Rendering ---

function buildMapCache() {
    if (!gameState.mapData) return;

    const mapSize = gameState.mapData.size;
    const cacheW = mapSize * camera.zoom;
    const cacheH = mapSize * camera.zoom;

    mapCache = document.createElement('canvas');
    mapCache.width = cacheW;
    mapCache.height = cacheH;
    const mctx = mapCache.getContext('2d');

    mctx.fillStyle = '#e0e0e0';
    mctx.fillRect(0, 0, cacheW, cacheH);

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

    mctx.strokeStyle = '#555';
    mctx.lineWidth = 4;
    mctx.strokeRect(0, 0, cacheW, cacheH);

    mapCacheDirty = false;
}

function drawCachedMap() {
    if (!mapCache) return;

    const startX = canvas.width / 2 - camera.x * camera.zoom;
    const startY = canvas.height / 2 - camera.y * camera.zoom;

    const srcX = Math.max(0, Math.floor(-startX));
    const srcY = Math.max(0, Math.floor(-startY));
    const destX = Math.max(0, Math.floor(startX));
    const destY = Math.max(0, Math.floor(startY));
    const drawW = Math.min(mapCache.width - srcX, canvas.width - destX);
    const drawH = Math.min(mapCache.height - srcY, canvas.height - destY);

    if (drawW <= 0 || drawH <= 0) return;

    ctx.drawImage(mapCache, srcX, srcY, drawW, drawH, destX, destY, drawW, drawH);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
    let diff = b - a;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return a + diff * t;
}

function getInterpolatedPlayers() {
    if (!prevGameState || !currGameState) return gameState.players;

    const serverTickMs = 50;
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
    const playerSize = 2 * camera.zoom;
    const radius = playerSize / 2;

    const vpLeft = -radius * 2;
    const vpRight = canvas.width + radius * 2;
    const vpTop = -radius * 2;
    const vpBottom = canvas.height + radius * 2;

    for (let id in interpolatedPlayers) {
        const p = interpolatedPlayers[id];
        if (p.hp <= 0) continue;

        const px = startX + p.x * camera.zoom;
        const py = startY + p.y * camera.zoom;

        if (px < vpLeft || px > vpRight || py < vpTop || py > vpBottom) continue;

        ctx.save();
        ctx.translate(px, py);

        // Name tag
        ctx.fillStyle = '#000';
        ctx.font = '10px "Press Start 2P"';
        ctx.textAlign = 'center';
        ctx.fillText(p.name, 0, -radius - 15);

        // Gövdeyi çiz (döndürmeden sabit kalsın)
        ctx.fillStyle = p.color;
        ctx.strokeStyle = '#222';
        ctx.lineWidth = 2;

        ctx.fillRect(-radius, -radius, playerSize, playerSize);
        ctx.strokeRect(-radius, -radius, playerSize, playerSize);

        // Kafayı çiz (sadece kafayı mouse'a göre döndürerek)
        ctx.rotate(p.angle);

        ctx.fillStyle = '#999';
        ctx.fillRect(0, -radius * 0.3, radius + 10, radius * 0.6);
        ctx.strokeRect(0, -radius * 0.3, radius + 10, radius * 0.6);

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

        if (bx < vpLeft || bx > vpRight || by < vpTop || by > vpBottom) continue;

        ctx.beginPath();
        ctx.arc(bx, by, bulletScreenR, 0, Math.PI * 2);
        ctx.fill();
    }
}

function gameLoop() {
    if (!gameState.playing) return;

    if (mapCacheDirty && gameState.mapData) {
        buildMapCache();
    }

    const interpolatedPlayers = getInterpolatedPlayers();

    // Camera target: follow self if alive, or spectated player if dead
    let cameraTarget = null;

    if (!isSpectating) {
        // Follow self
        cameraTarget = interpolatedPlayers[myId] || gameState.players[myId];
    } else if (spectateTargetId && interpolatedPlayers[spectateTargetId]) {
        // Follow spectated player
        cameraTarget = interpolatedPlayers[spectateTargetId];
    }

    if (cameraTarget) {
        camera.x += (cameraTarget.x - camera.x) * 0.1;
        camera.y += (cameraTarget.y - camera.y) * 0.1;
    } else if (gameState.mapData) {
        camera.x = gameState.mapData.size / 2;
        camera.y = gameState.mapData.size / 2;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawCachedMap();
    drawBullets();
    drawPlayers(interpolatedPlayers);

    requestAnimationFrame(gameLoop);
}
