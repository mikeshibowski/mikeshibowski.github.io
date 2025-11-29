/**
 * ADHD Clock Application
 *
 * Time Structure:
 * - 1 Part = 12 minutes (720 seconds)
 * - 1 Work Hour = 5 Parts (60 minutes)
 * - 1 Block = 5 Work Hours (5 hours)
 * - Active Workday = 3 Blocks (15 hours)
 *
 * Ring Structure:
 * - Ring 1 (outer): 5 segments - Hours
 * - Ring 2: 5 segments - Parts
 * - Ring 3 (inner): Continuous - Progress within current part
 */

const STORAGE_KEY = 'adhd_bedtime';
const ENDPOINT_STORAGE_KEY = 'adhd_focus_endpoint';
const TOKEN_STORAGE_KEY = 'adhd_focus_token';
const THEME_STORAGE_KEY = 'adhd_theme';
const DEFAULT_BEDTIME = '23:00';
const DEFAULT_THEME = 'blue';

// Time constants in milliseconds
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const PART_DURATION = 12 * MINUTE;      // 12 minutes
const WORK_HOUR_DURATION = 5 * PART_DURATION;  // 60 minutes (5 parts)
const BLOCK_DURATION = 5 * WORK_HOUR_DURATION; // 5 hours (5 work hours)

const WIND_DOWN_DURATION = 30 * MINUTE;  // 30 minutes
const SLEEP_DURATION = 8 * HOUR;         // 8 hours
const SET_UP_DURATION = 30 * MINUTE;     // 30 minutes

// Phase identifiers
const PHASES = {
    SLEEP: 'sleep',
    SET_UP: 'setup',
    BLOCK_1: 'block1',
    BLOCK_2: 'block2',
    BLOCK_3: 'block3',
    WIND_DOWN: 'winddown'
};

// Ring configuration (matching CSS variables)
const CONFIG = {
    maxRingRadius: 100,  // outer edge of outermost ring
    ringWidth: 10,
    ringGap: 7,        // radial gap between rings
    segmentGap: 14,      // arc gap between segment ends
    viewBoxSize: 200,
    center: 100,
    opacityStep: 0.35    // opacity decrease per ring level (outer=1, center=0.8, inner=0.6, active circle=0.4)
};

// Audio context for beep sounds
let audioContext = null;

// DOM Elements
const elements = {
    clock: document.querySelector('.clock'),
    bhpTime: document.querySelector('.bhp-time'),
    bedtimeInput: document.getElementById('bedtime-input'),
    endpointInput: document.getElementById('endpoint-input'),
    saveButton: document.getElementById('save-settings'),
    settingsToggle: document.querySelector('.settings-toggle'),
    settingsPanel: document.querySelector('.settings-panel'),
    saveFeedback: document.querySelector('.save-feedback'),
    scheduleItems: document.querySelectorAll('.schedule-item'),
    // SVG segments for each ring
    hourSegments: document.querySelectorAll('.ring-hour .segment'),
    partSegments: document.querySelectorAll('.ring-part .segment'),
    progressBg: document.querySelector('.ring-progress .segment-bg'),
    progressFill: document.querySelector('.ring-progress .segment-fill'),
    // Focus elements
    centerDisplay: document.getElementById('center-display'),
    focusInputContainer: document.getElementById('focus-input-container'),
    focusTaskInput: document.getElementById('focus-task-input'),
    focusStartBtn: document.getElementById('focus-start-btn'),
    focusCancelBtn: document.getElementById('focus-cancel-btn'),
    focusTaskText: document.getElementById('focus-task-text')
};

// Application state
let state = {
    bedtime: DEFAULT_BEDTIME,
    endpointUrl: '',
    accessToken: '',
    theme: DEFAULT_THEME,
    currentPhase: null,
    milestones: {},
    // Track previous segment values for beep detection
    previousPart: null,
    previousHour: null,
    // Focus state
    isFocusing: false,
    focusTask: ''
};

/**
 * Initialize the application
 */
function init() {
    loadSettings();
    initializeRings();
    initializeAudio();
    calculateMilestones();
    updateScheduleDisplay();
    updateClock();
    checkFocusState();

    // Start the clock update interval
    setInterval(updateClock, 1000);

    // Setup event listeners
    elements.settingsToggle.addEventListener('click', toggleSettings);
    elements.saveButton.addEventListener('click', saveSettings);
    elements.bedtimeInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') saveSettings();
    });

    // Focus event listeners - center circle is the button
    elements.centerDisplay.addEventListener('click', handleCenterClick);
    elements.centerDisplay.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' || e.key === ' ') handleCenterClick();
    });
    elements.focusStartBtn.addEventListener('click', startFocus);
    elements.focusCancelBtn.addEventListener('click', hideFocusInput);
    elements.focusTaskInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startFocus();
    });
    elements.focusTaskInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideFocusInput();
    });

    // Theme selector event listeners
    const themeBtns = document.querySelectorAll('.theme-btn');
    themeBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setTheme(btn.dataset.theme);
        });
    });

    // Test endpoint button
    document.getElementById('test-endpoint').addEventListener('click', testEndpoint);
}

/**
 * Handle click on center display - toggle focus
 */
function handleCenterClick() {
    if (state.isFocusing) {
        stopFocus();
    } else {
        showFocusInput();
    }
}

/**
 * Initialize audio context for beep sounds
 */
function initializeAudio() {
    // Audio context will be created on first user interaction
    document.addEventListener('click', () => {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    }, { once: true });
}

/**
 * Play a gentle beep sound
 */
function playBeep() {
    if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800; // Gentle high frequency
    oscillator.type = 'sine';

    // Gentle fade in and out
    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.1, audioContext.currentTime + 0.05);
    gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + 0.2);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
}

/**
 * Calculate ring radii from outside to inside
 */
function calculateRadii() {
    const { maxRingRadius, ringWidth, ringGap } = CONFIG;

    // Calculate radii for each ring (center of stroke)
    const radii = [];
    let currentRadius = maxRingRadius - ringWidth / 2;

    // Only 3 rings now (hour, part, progress)
    for (let i = 0; i < 3; i++) {
        radii.push(currentRadius);
        currentRadius -= ringWidth + ringGap;
    }

    return radii;
}

/**
 * Initialize SVG ring segments with proper positioning and stroke-dasharray
 */
function initializeRings() {
    const radii = calculateRadii();
    const { ringWidth, segmentGap, opacityStep } = CONFIG;

    // Ring 1 (Hour - outer): 5 segments - full opacity
    setupSegmentedRing(elements.hourSegments, radii[0], 5, segmentGap, ringWidth);
    elements.hourSegments.forEach(s => s.style.opacity = 1);

    // Ring 2 (Part - middle): 5 segments - medium opacity
    setupSegmentedRing(elements.partSegments, radii[1], 5, segmentGap, ringWidth);
    elements.partSegments.forEach(s => s.style.opacity = 1 - opacityStep);

    // Ring 3 (Progress - inner): Continuous - lowest opacity
    setupContinuousRing(elements.progressBg, elements.progressFill, radii[2], ringWidth);
    const progressOpacity = 1 - opacityStep * 2;
    elements.progressBg.style.opacity = progressOpacity;
    elements.progressFill.style.opacity = progressOpacity;

}

/**
 * Setup a segmented ring with gaps
 * Gap is specified in SVG units (pixels) and converted to arc length for each ring
 * Adds rotation offset so first segment starts centered at top
 */
function setupSegmentedRing(segments, radius, segmentCount, gapPixels, strokeWidth) {
    const circumference = 2 * Math.PI * radius;

    // Convert pixel gap to arc length - gapPixels is the straight-line distance
    // For small gaps, arc length ≈ chord length, so we use gapPixels directly
    const gapLength = gapPixels;
    const totalGapLength = gapLength * segmentCount;
    const segmentLength = (circumference - totalGapLength) / segmentCount;

    // Rotation offset: shift by half a gap so segments appear symmetrical
    const rotationOffset = -gapLength / 2;

    segments.forEach((segment, i) => {
        segment.setAttribute('r', radius);
        segment.style.strokeWidth = strokeWidth;
        segment.style.strokeDasharray = `${segmentLength} ${circumference - segmentLength}`;
        const offset = -i * (segmentLength + gapLength) + rotationOffset;
        segment.style.strokeDashoffset = offset;
    });
}

/**
 * Setup a progress ring (arc with gap at top, round ends)
 */
function setupContinuousRing(bgElement, fillElement, radius, strokeWidth) {
    const circumference = 2 * Math.PI * radius;
    const { segmentGap } = CONFIG;

    // Create arc with small gap at top (same gap size as segments)
    const arcLength = circumference - segmentGap;

    // Offset to center the gap at the top (negative to rotate clockwise)
    // The arc starts drawing from the offset point, so we shift it back by half gap
    const gapOffset = -segmentGap / 2;

    bgElement.setAttribute('r', radius);
    bgElement.style.strokeWidth = strokeWidth;
    bgElement.style.strokeDasharray = `${arcLength} ${segmentGap}`;
    bgElement.style.strokeDashoffset = gapOffset;
    bgElement.style.strokeLinecap = 'round';

    fillElement.setAttribute('r', radius);
    fillElement.style.strokeWidth = strokeWidth;
    fillElement.style.strokeLinecap = 'round';
    // Start with no fill, will be updated by progress
    fillElement.style.strokeDasharray = `0 ${circumference}`;
    fillElement.style.strokeDashoffset = gapOffset;

    // Store arc length for progress calculations
    fillElement.dataset.arcLength = arcLength;
    fillElement.dataset.gapOffset = gapOffset;
}

/**
 * Load settings from localStorage
 */
function loadSettings() {
    const savedBedtime = localStorage.getItem(STORAGE_KEY);
    const savedEndpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY);
    const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);

    if (savedBedtime) {
        state.bedtime = savedBedtime;
    } else {
        elements.settingsPanel.classList.remove('hidden');
    }

    if (savedEndpoint) {
        state.endpointUrl = savedEndpoint;
    }

    if (savedToken) {
        state.accessToken = savedToken;
    }

    if (savedTheme) {
        state.theme = savedTheme;
    }

    elements.bedtimeInput.value = state.bedtime;
    elements.endpointInput.value = state.endpointUrl;
    document.getElementById('token-input').value = state.accessToken;

    // Apply saved theme
    setTheme(state.theme, false);
}

/**
 * Save all settings to localStorage
 */
function saveSettings() {
    const newBedtime = elements.bedtimeInput.value;
    const newEndpoint = elements.endpointInput.value;
    const newToken = document.getElementById('token-input').value;

    if (newBedtime) {
        state.bedtime = newBedtime;
        localStorage.setItem(STORAGE_KEY, newBedtime);

        calculateMilestones();
        updateScheduleDisplay();
        updateClock();
    }

    state.endpointUrl = newEndpoint;
    localStorage.setItem(ENDPOINT_STORAGE_KEY, newEndpoint);

    state.accessToken = newToken;
    localStorage.setItem(TOKEN_STORAGE_KEY, newToken);

    elements.saveFeedback.classList.remove('hidden');
    setTimeout(() => {
        elements.saveFeedback.classList.add('hidden');
    }, 2000);
}

/**
 * Get headers for API requests
 */
function getApiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (state.accessToken) {
        headers['Authorization'] = `Bearer ${state.accessToken}`;
    }
    return headers;
}

/**
 * Test endpoint connection
 */
async function testEndpoint() {
    const testBtn = document.getElementById('test-endpoint');
    const testResult = document.getElementById('test-result');
    const endpointUrl = elements.endpointInput.value;

    if (!endpointUrl) {
        testResult.textContent = 'Please enter an endpoint URL';
        testResult.className = 'test-result error';
        return;
    }

    testBtn.disabled = true;
    testBtn.textContent = 'Testing...';
    testResult.classList.add('hidden');

    try {
        const response = await fetch(`${endpointUrl}/getState`, {
            method: 'GET',
            headers: getApiHeaders()
        });

        if (response.ok) {
            const data = await response.json();
            testResult.textContent = `Connected! Status: ${data.focused ? 'Focusing' : 'Not focusing'}`;
            testResult.className = 'test-result success';
        } else {
            testResult.textContent = `Error: ${response.status} ${response.statusText}`;
            testResult.className = 'test-result error';
        }
    } catch (error) {
        testResult.textContent = `Connection failed: ${error.message}`;
        testResult.className = 'test-result error';
    }

    testBtn.disabled = false;
    testBtn.textContent = 'Test Endpoint';
}

/**
 * Toggle settings panel visibility
 */
function toggleSettings() {
    elements.settingsPanel.classList.toggle('hidden');
}

/**
 * Parse time string (HH:MM) to hours and minutes
 */
function parseTime(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return { hours, minutes };
}

/**
 * Calculate all milestone times based on bedtime
 */
function calculateMilestones() {
    const now = new Date();
    const { hours: bedHour, minutes: bedMin } = parseTime(state.bedtime);

    let bedtime = new Date(now);
    bedtime.setHours(bedHour, bedMin, 0, 0);

    let recentBedtime = new Date(bedtime);
    if (now < bedtime) {
        recentBedtime.setDate(recentBedtime.getDate() - 1);
    }

    const milestones = {};

    milestones.windDownStart = new Date(recentBedtime.getTime() - WIND_DOWN_DURATION);
    milestones.sleepStart = new Date(recentBedtime);
    milestones.sleepEnd = new Date(recentBedtime.getTime() + SLEEP_DURATION);
    milestones.setUpStart = new Date(milestones.sleepEnd);
    milestones.setUpEnd = new Date(milestones.sleepEnd.getTime() + SET_UP_DURATION);
    milestones.block1Start = new Date(milestones.setUpEnd);
    milestones.block1End = new Date(milestones.block1Start.getTime() + BLOCK_DURATION);
    milestones.block2Start = new Date(milestones.block1End);
    milestones.block2End = new Date(milestones.block2Start.getTime() + BLOCK_DURATION);
    milestones.block3Start = new Date(milestones.block2End);
    milestones.block3End = new Date(milestones.block3Start.getTime() + BLOCK_DURATION);
    milestones.windDownEnd = new Date(recentBedtime.getTime() + 24 * HOUR);

    state.milestones = milestones;
}

/**
 * Determine the current phase based on current time
 */
function getCurrentPhase(now) {
    const m = state.milestones;
    const time = now.getTime();

    if (time >= m.sleepStart.getTime() && time < m.sleepEnd.getTime()) {
        return PHASES.SLEEP;
    } else if (time >= m.setUpStart.getTime() && time < m.setUpEnd.getTime()) {
        return PHASES.SET_UP;
    } else if (time >= m.block1Start.getTime() && time < m.block1End.getTime()) {
        return PHASES.BLOCK_1;
    } else if (time >= m.block2Start.getTime() && time < m.block2End.getTime()) {
        return PHASES.BLOCK_2;
    } else if (time >= m.block3Start.getTime() && time < m.block3End.getTime()) {
        return PHASES.BLOCK_3;
    } else if (time >= m.windDownStart.getTime() && time < m.sleepStart.getTime()) {
        return PHASES.WIND_DOWN;
    } else {
        calculateMilestones();
        return getCurrentPhase(now);
    }
}

/**
 * Calculate B-H-P values for a given time within a block
 */
function calculateBHP(now, blockStart, blockNumber) {
    const elapsed = now.getTime() - blockStart.getTime();

    // Calculate Part (1-5)
    const totalParts = Math.floor(elapsed / PART_DURATION);
    const part = (totalParts % 5) + 1;

    // Calculate Hour (1-5)
    const totalHours = Math.floor(elapsed / WORK_HOUR_DURATION);
    const hour = (totalHours % 5) + 1;

    // Progress within current part (0-1) - updated every second
    const partProgress = (elapsed % PART_DURATION) / PART_DURATION;

    // Completed parts in this hour (0-4)
    const completedParts = totalParts % 5;

    // Completed hours in this block (0-4)
    const completedHours = totalHours % 5;

    // Completed blocks (0-2)
    const completedBlocks = blockNumber - 1;

    return {
        block: blockNumber,
        hour,
        part,
        partProgress,
        completedParts,
        completedHours,
        completedBlocks
    };
}

/**
 * Update the clock display
 */
function updateClock() {
    const now = new Date();

    if (!state.milestones.sleepStart) {
        calculateMilestones();
    }

    const phase = getCurrentPhase(now);
    state.currentPhase = phase;

    updateScheduleHighlight(phase);

    if (phase.startsWith('block')) {
        updateBlockDisplay(now, phase);
    } else {
        updateNonActiveDisplay(now, phase);
    }
}

/**
 * Update display for active block phases
 */
function updateBlockDisplay(now, phase) {
    elements.clock.classList.remove('non-active');

    let blockStart, blockNumber;

    switch (phase) {
        case PHASES.BLOCK_1:
            blockStart = state.milestones.block1Start;
            blockNumber = 1;
            break;
        case PHASES.BLOCK_2:
            blockStart = state.milestones.block2Start;
            blockNumber = 2;
            break;
        case PHASES.BLOCK_3:
            blockStart = state.milestones.block3Start;
            blockNumber = 3;
            break;
    }

    const bhp = calculateBHP(now, blockStart, blockNumber);

    // Update B-H-P display
    elements.bhpTime.textContent = `${bhp.block}-${bhp.hour}-${bhp.part}`;

    // Check for segment transitions and play beep
    if (state.previousPart !== null && state.previousHour !== null) {
        if (bhp.part !== state.previousPart || bhp.hour !== state.previousHour) {
            playBeep();
        }
    }
    state.previousPart = bhp.part;
    state.previousHour = bhp.hour;

    // Ring 1: Hour segments (fill completed + current)
    elements.hourSegments.forEach((segment, i) => {
        if (i <= bhp.completedHours) {
            segment.classList.add('filled');
        } else {
            segment.classList.remove('filled');
        }
    });

    // Ring 2: Part segments (fill completed + current)
    elements.partSegments.forEach((segment, i) => {
        if (i <= bhp.completedParts) {
            segment.classList.add('filled');
        } else {
            segment.classList.remove('filled');
        }
    });

    // Ring 3: Progress arc within current part
    const arcLength = parseFloat(elements.progressFill.dataset.arcLength);
    const gapOffset = parseFloat(elements.progressFill.dataset.gapOffset);
    const filledLength = arcLength * bhp.partProgress;
    elements.progressFill.style.strokeDasharray = `${filledLength} ${arcLength * 2}`;
    elements.progressFill.style.strokeDashoffset = gapOffset;
}

/**
 * Update display for non-active phases (Sleep, Set Up, Wind Down)
 */
function updateNonActiveDisplay(now, phase) {
    elements.clock.classList.add('non-active');

    let phaseStart, phaseEnd, text;

    switch (phase) {
        case PHASES.SLEEP:
            phaseStart = state.milestones.sleepStart;
            phaseEnd = state.milestones.sleepEnd;
            text = 'Sleep';
            break;
        case PHASES.SET_UP:
            phaseStart = state.milestones.setUpStart;
            phaseEnd = state.milestones.setUpEnd;
            text = 'Set Up';
            break;
        case PHASES.WIND_DOWN:
            phaseStart = state.milestones.windDownStart;
            phaseEnd = state.milestones.sleepStart;
            text = 'Wind Down';
            break;
    }

    // Calculate remaining time
    const remaining = phaseEnd.getTime() - now.getTime();
    const remainingMinutes = Math.ceil(remaining / MINUTE);

    // Hide center content during non-active phases
    elements.bhpTime.textContent = '';

    // Reset segment tracking for non-active phases
    state.previousPart = null;
    state.previousHour = null;

    // Clear all segments
    elements.hourSegments.forEach(s => s.classList.remove('filled'));
    elements.partSegments.forEach(s => s.classList.remove('filled'));

    // Show progress in innermost ring for non-active phases
    const progress = (now.getTime() - phaseStart.getTime()) / (phaseEnd.getTime() - phaseStart.getTime());
    const arcLength = parseFloat(elements.progressFill.dataset.arcLength);
    const gapOffset = parseFloat(elements.progressFill.dataset.gapOffset);
    const filledLength = arcLength * progress;
    elements.progressFill.style.strokeDasharray = `${filledLength} ${arcLength * 2}`;
    elements.progressFill.style.strokeDashoffset = gapOffset;
}

/**
 * Update schedule overview highlighting
 */
function updateScheduleHighlight(phase) {
    elements.scheduleItems.forEach(item => {
        item.classList.remove('active');
        if (item.dataset.phase === phase) {
            item.classList.add('active');
        }
    });
}

/**
 * Update schedule times display
 */
function updateScheduleDisplay() {
    const m = state.milestones;

    document.querySelector('.setup-time').textContent =
        `${formatTime(m.setUpStart)} - ${formatTime(m.setUpEnd)}`;
    document.querySelector('.block1-time').textContent =
        `${formatTime(m.block1Start)} - ${formatTime(m.block1End)}`;
    document.querySelector('.block2-time').textContent =
        `${formatTime(m.block2Start)} - ${formatTime(m.block2End)}`;
    document.querySelector('.block3-time').textContent =
        `${formatTime(m.block3Start)} - ${formatTime(m.block3End)}`;
    document.querySelector('.winddown-time').textContent =
        `${formatTime(m.windDownStart)} - ${formatTime(m.sleepStart)}`;
    document.querySelector('.sleep-time').textContent =
        `${formatTime(m.sleepStart)} - ${formatTime(m.sleepEnd)}`;
}

/**
 * Format date to HH:MM string
 */
function formatTime(date) {
    return date.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

// ==================== Theme Functionality ====================

/**
 * Set the active theme
 */
function setTheme(theme, save = true) {
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);

    // Update active state on buttons
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === theme);
    });

    if (save) {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
}

// ==================== Focus Functionality ====================

/**
 * Show focus input dialog
 */
function showFocusInput() {
    elements.focusInputContainer.classList.remove('hidden');
    elements.focusTaskInput.focus();
}

/**
 * Hide focus input dialog
 */
function hideFocusInput() {
    elements.focusInputContainer.classList.add('hidden');
    elements.focusTaskInput.value = '';
}

/**
 * Start focus session
 */
async function startFocus() {
    const task = elements.focusTaskInput.value.trim();
    if (!task) {
        elements.focusTaskInput.focus();
        return;
    }

    hideFocusInput();

    // Send to endpoint
    if (state.endpointUrl) {
        try {
            await fetch(`${state.endpointUrl}/start`, {
                method: 'POST',
                headers: getApiHeaders(),
                body: JSON.stringify({ task })
            });
        } catch (error) {
            console.error('Failed to notify endpoint:', error);
        }
    }

    // Update local state
    state.isFocusing = true;
    state.focusTask = task;
    updateFocusUI();
}

/**
 * Stop focus session
 */
async function stopFocus() {
    // Send to endpoint
    if (state.endpointUrl) {
        try {
            await fetch(`${state.endpointUrl}/stop`, {
                method: 'POST',
                headers: getApiHeaders()
            });
        } catch (error) {
            console.error('Failed to notify endpoint:', error);
        }
    }

    // Update local state
    state.isFocusing = false;
    state.focusTask = '';
    updateFocusUI();
}

/**
 * Check focus state from endpoint
 */
async function checkFocusState() {
    if (!state.endpointUrl) return;

    try {
        const response = await fetch(`${state.endpointUrl}/getState`, {
            headers: getApiHeaders()
        });
        if (response.ok) {
            const data = await response.json();
            state.isFocusing = data.focused || false;
            state.focusTask = data.task || '';
            updateFocusUI();
        }
    } catch (error) {
        console.error('Failed to check focus state:', error);
    }
}

/**
 * Update focus UI based on state
 */
function updateFocusUI() {
    if (state.isFocusing) {
        elements.centerDisplay.classList.add('focusing');
        elements.focusTaskText.textContent = state.focusTask;
    } else {
        elements.centerDisplay.classList.remove('focusing');
        elements.focusTaskText.textContent = '';
    }
}

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', init);
