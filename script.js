(async function() {
    // --- Global state ---
    let instances = []; let currentIndex = 0; let userProfile = {}; let validationData = {}; let N = 0; let totalSentencesInSession = 0; let firstUnfinishedIndex = 0; let recordings = [];
    let mediaRecorder; let audioChunks = []; let isRecording = false; let currentRecordingLang = null; let activeStream = null;
    let recordingMode = 'bilingual';
    let isExistingUser = false; 
    const MAX_PREFERRED_SAMPLE_RATE = 96000;
    const DEFAULT_HIGH_QUALITY_SAMPLE_RATE = 48000;
    const HIGH_FIDELITY_AUDIO_CONSTRAINTS = {
        audio: {
            sampleRate: { ideal: MAX_PREFERRED_SAMPLE_RATE },
            channelCount: { ideal: 1 },
            sampleSize: { ideal: 16 },
            echoCancellation: { ideal: false },
            noiseSuppression: { ideal: false },
            autoGainControl: { ideal: false }
        }
    };
    let micInfo = { userAgent: navigator.userAgent, deviceType: 'Unknown', label: 'N/A', maxPreferredSampleRate: MAX_PREFERRED_SAMPLE_RATE, requestedSampleRate: MAX_PREFERRED_SAMPLE_RATE, sampleRate: 'N/A', trackSampleRate: 'N/A', audioContextSampleRate: 'N/A', sampleRateSource: 'N/A', sampleRateCapabilities: 'N/A', channelCount: 'N/A', sampleSize: 'N/A', mimeType: 'N/A', autoGainControl: 'N/A', noiseSuppression: 'N/A', echoCancellation: 'N/A' };
    const intentToId = { "SOS_CALL": 1, "FALL_HELP": 2, "BREATHING_CHEST_EMERG": 3, "PAIN_GENERAL": 4, "CALL_CONTACT": 5, "LIGHT_ON": 6, "LIGHT_OFF": 7, "CANCEL_ALERT": 8, };
    const fluencyLevels = { 1: "完全不會", 2: "略懂", 3: "可日常溝通", 4: "流利", 5: "母語程度" };

    function shouldRetryBasicAudio(err) {
        return err && ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'TypeError'].includes(err.name);
    }

    async function getHighFidelityAudioStream() {
        try {
            return await navigator.mediaDevices.getUserMedia(HIGH_FIDELITY_AUDIO_CONSTRAINTS);
        } catch (err) {
            if (!shouldRetryBasicAudio(err)) throw err;
            console.warn('High-quality microphone constraints were not fully accepted; falling back to basic audio constraints.', err);
            return navigator.mediaDevices.getUserMedia({ audio: true });
        }
    }

    function getTrackCapabilities(track) {
        if (!track || typeof track.getCapabilities !== 'function') return null;
        try {
            return track.getCapabilities();
        } catch (err) {
            console.warn('Unable to read microphone capabilities.', err);
            return null;
        }
    }

    function supportsSampleRate(capabilities, sampleRate) {
        const cap = capabilities && capabilities.sampleRate;
        if (!cap) return false;
        if (typeof cap === 'number') return cap === sampleRate;
        const min = Number(cap.min);
        const max = Number(cap.max);
        if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
        return min <= sampleRate && sampleRate <= max;
    }

    function chooseRequestedSampleRate(capabilities) {
        const cap = capabilities && capabilities.sampleRate;
        if (!cap) return MAX_PREFERRED_SAMPLE_RATE;
        if (typeof cap === 'number') return Math.min(cap, MAX_PREFERRED_SAMPLE_RATE);

        const min = Number(cap.min);
        const max = Number(cap.max);
        if (Number.isFinite(min) && Number.isFinite(max) && max > 0) {
            const target = Math.min(max, MAX_PREFERRED_SAMPLE_RATE);
            return target >= min ? target : MAX_PREFERRED_SAMPLE_RATE;
        }
        return MAX_PREFERRED_SAMPLE_RATE;
    }

    async function requestTrackSampleRate(track, capabilities) {
        const requestedSampleRate = chooseRequestedSampleRate(capabilities);
        if (!track || typeof track.applyConstraints !== 'function') return requestedSampleRate;
        const sampleRateConstraint = supportsSampleRate(capabilities, requestedSampleRate) ? { exact: requestedSampleRate } : { ideal: requestedSampleRate };
        try {
            await track.applyConstraints({
                sampleRate: sampleRateConstraint,
                channelCount: { ideal: 1 },
                sampleSize: { ideal: 16 },
                echoCancellation: { ideal: false },
                noiseSuppression: { ideal: false },
                autoGainControl: { ideal: false }
            });
        } catch (err) {
            if (requestedSampleRate !== DEFAULT_HIGH_QUALITY_SAMPLE_RATE && supportsSampleRate(capabilities, DEFAULT_HIGH_QUALITY_SAMPLE_RATE)) {
                try {
                    await track.applyConstraints({ sampleRate: { exact: DEFAULT_HIGH_QUALITY_SAMPLE_RATE } });
                    return DEFAULT_HIGH_QUALITY_SAMPLE_RATE;
                } catch (fallbackErr) {
                    console.warn('The browser did not accept high-sample-rate microphone constraints. The actual sample rate will be preserved without artificial upsampling.', fallbackErr);
                }
            } else {
                console.warn('The browser did not accept high-sample-rate microphone constraints. The actual sample rate will be preserved without artificial upsampling.', err);
            }
        }
        return requestedSampleRate;
    }

    function getTrackSettings(track) {
        if (!track || typeof track.getSettings !== 'function') return {};
        try {
            return track.getSettings() || {};
        } catch (err) {
            console.warn('Unable to read microphone settings.', err);
            return {};
        }
    }

    function valueOrNA(value) {
        return value === undefined || value === null || value === '' ? 'N/A' : value;
    }

    function createAudioContextForTrack(trackSettings) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('Web Audio API not supported');
        const trackSampleRate = Number(trackSettings && trackSettings.sampleRate);
        if (trackSampleRate > 0) {
            try {
                return new Ctx({ sampleRate: trackSampleRate });
            } catch (err) {
                console.warn('This browser does not support a requested AudioContext sampleRate; using the default.', err);
            }
        }
        return new Ctx();
    }

    function chooseRecorderMimeType() {
        const preferredMimeTypes = ['audio/wav', 'audio/webm;codecs=opus', 'audio/webm'];
        if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
        return preferredMimeTypes.find(type => MediaRecorder.isTypeSupported(type)) || '';
    }

    function audioExtensionForMimeType(mimeType) {
        return /^audio\/wav\b/i.test(mimeType || '') ? 'wav' : 'webm';
    }

    // --- DOM element references ---
    const validationScreen = document.getElementById('validation-screen'); const questionnaireScreen = document.getElementById('questionnaire-screen'); const languageSelectionScreen = document.getElementById('language-selection-screen'); const sessionSelectionScreen = document.getElementById('session-selection-screen'); const mainScreen = document.getElementById('main-screen'); const validationForm = document.getElementById('validation-form'); const questionnaireForm = document.getElementById('questionnaire-form'); const sessionForm = document.getElementById('session-form'); const validateBtn = document.getElementById('validate-btn'); const submitQuestionnaireBtn = document.getElementById('submit-questionnaire-btn'); const modeTwOnlyBtn = document.getElementById('mode-tw-only'); const modeBilingualBtn = document.getElementById('mode-bilingual'); const startSessionBtn = document.getElementById('start-session-btn'); const fluencyGroup = document.getElementById('fluency-group'); const nativeCheckboxes = document.querySelectorAll('input[name="nativeLanguage"]'); const nativeOtherText = document.getElementById('native-other-text'); const validationErrorMsg = document.getElementById('validation-error-msg'); const questionnaireErrorMsg = document.getElementById('questionnaire-error-msg'); const sessionErrorMsg = document.getElementById('session-error-msg'); const progressDisplay = document.getElementById('progress-display');

    // --- Consent and example-video DOM references added in 2026-05 ---
    const consentScreen = document.getElementById('consent-screen');
    const exampleVideoScreen = document.getElementById('example-video-screen');
    const consentCheckbox = document.getElementById('consent-checkbox');
    const agreeBtn = document.getElementById('agree-btn');
    const consentErrorMsg = document.getElementById('consent-error-msg');
    const btnBackConsent = document.getElementById('btn-back-consent');
    const exampleVideo = document.getElementById('example-video');
    const continueFromExampleBtn = document.getElementById('continue-from-example-btn');
    const btnBackExample = document.getElementById('btn-back-example');
    
    // Video DOM references.
    const videoThumbnailContainer = document.getElementById('video-thumbnail-container'); 
    const videoPoster = document.getElementById('video-poster');
    const playOverlay = document.getElementById('play-overlay');
    const contextVideo = document.getElementById('context-video');
    const videoHint = document.getElementById('video-hint');

    // Prompt display DOM references.
    const scriptInstruction = document.getElementById('script-instruction'); 
    const scriptDescription = document.getElementById('script-description'); 
    const scriptToReadZh = document.getElementById('script-to-read-zh');
    const scriptToReadTw = document.getElementById('script-to-read-tw'); 

    const prevBtn = document.getElementById('prev-btn'); const nextBtn = document.getElementById('next-btn'); const finishBtn = document.getElementById('finish-btn'); const recorderTw = document.getElementById('recorder-tw'); const recorderZh = document.getElementById('recorder-zh');
    
    // Back-button DOM references.
    const btnBackQuestionnaire = document.getElementById('btn-back-questionnaire');
    const btnBackLanguage = document.getElementById('btn-back-language');
    const btnBackSession = document.getElementById('btn-back-session');
    const btnBackMain = document.getElementById('btn-back-main');

    // --- Keyboard interaction helpers ---
    
    // Use offsetParent to confirm the screen is truly visible, avoiding stale CSS-class false positives.
    function isScreenVisible(screen) {
        return screen && screen.offsetParent !== null;
    }

    function simulateClick(element) {
        if (element && !element.disabled && element.offsetParent !== null) {
            element.classList.add('active-key'); // Add pressed-state feedback.
            setTimeout(() => element.classList.remove('active-key'), 150); // Remove pressed-state feedback.
            element.click();
        }
    }

    function isEditableElement(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        const targetTag = target.tagName.toLowerCase();
        const targetType = target.type;
        return (targetTag === 'input' && !['radio', 'checkbox', 'button', 'submit', 'reset', 'file'].includes(targetType)) ||
               targetTag === 'textarea' ||
               targetTag === 'select';
    }

    function isShortcutSuppressedTarget(target) {
        if (!target) return false;
        if (isEditableElement(target)) return true;
        const targetTag = target.tagName.toLowerCase();
        return ['button', 'label', 'option'].includes(targetTag) || target.closest('form');
    }

    function toggleVideoPlay() {
        if (isScreenVisible(mainScreen)) {
            if (contextVideo.style.display === 'none') {
                // Play.
                videoPoster.style.display = 'none';
                playOverlay.style.display = 'none';
                videoHint.style.display = 'none';
                contextVideo.style.display = 'block';
                contextVideo.play().catch(e => console.error("Video autoplay failed:", e));
            } else {
                // Pause or resume.
                if (contextVideo.paused) {
                    contextVideo.play();
                } else {
                    contextVideo.pause();
                }
            }
        }
    }

    function autoPlayContextVideo() {
        // Called when entering the recording screen or advancing to the next sentence.
        if (!isScreenVisible(mainScreen) || !contextVideo) return;
        if (videoPoster) videoPoster.style.display = 'none';
        if (playOverlay) playOverlay.style.display = 'none';
        if (videoHint) videoHint.style.display = 'none';
        contextVideo.style.display = 'block';
        // Try autoplay with sound, then retry muted if the browser blocks it.
        contextVideo.muted = false;
        contextVideo.volume = 1.0;
        const p = contextVideo.play();
        if (p && typeof p.then === 'function') {
            p.catch(err => {
                console.warn('Autoplay with sound failed; retrying muted.', err);
                contextVideo.muted = true;
                contextVideo.play().catch(e => console.warn('Muted autoplay also failed.', e));
            });
        }
    }

    function handleGlobalKeyDown(e) {
        if (e.isComposing || e.keyCode === 229 || e.metaKey || e.ctrlKey || e.altKey) {
            return;
        }

        // 1. Global Esc handling, kept first so it takes priority.
        if (e.key === 'Escape') {
            e.preventDefault();
            // Trigger the matching back button for the screen that is actually visible.
            if (isScreenVisible(consentScreen)) simulateClick(btnBackConsent);
            else if (isScreenVisible(exampleVideoScreen)) simulateClick(btnBackExample);
            else if (isScreenVisible(questionnaireScreen)) simulateClick(btnBackQuestionnaire);
            else if (isScreenVisible(languageSelectionScreen)) simulateClick(btnBackLanguage);
            else if (isScreenVisible(sessionSelectionScreen)) simulateClick(btnBackSession);
            else if (isScreenVisible(mainScreen)) simulateClick(btnBackMain);
            return;
        }

        const target = e.target;
        if (isShortcutSuppressedTarget(target)) {
            return;
        }

        // --- Shortcuts that apply only outside text-input contexts ---

        // 2. Global Enter handling for confirmation and next-step actions.
        if (e.key === 'Enter') {
            if (isScreenVisible(consentScreen)) {
                e.preventDefault();
                if (agreeBtn && !agreeBtn.disabled) simulateClick(agreeBtn);
                else if (consentCheckbox && !consentCheckbox.checked && consentErrorMsg) {
                    consentErrorMsg.textContent = '請先勾選「我已仔細閱讀並同意」';
                }
                return;
            }
            if (isScreenVisible(exampleVideoScreen)) {
                e.preventDefault();
                if (continueFromExampleBtn) simulateClick(continueFromExampleBtn);
                return;
            }
            if (isScreenVisible(sessionSelectionScreen)) {
                e.preventDefault();
                simulateClick(startSessionBtn);
                return;
            }

            e.preventDefault();
            if (isScreenVisible(mainScreen)) {
                if (finishBtn.style.display !== 'none' && !finishBtn.disabled) {
                    simulateClick(finishBtn);
                } else {
                    simulateClick(nextBtn);
                }
            }
            return;
        }

        // 3. Session-length screen: number keys 1-9 select options quickly.
        if (isScreenVisible(sessionSelectionScreen)) {
            const num = parseInt(e.key);
            if (!isNaN(num) && num > 0) {
                const radios = sessionForm.querySelectorAll('input[name="sessionDuration"]');
                if (radios[num - 1]) {
                    e.preventDefault();
                    radios[num - 1].click(); 
                    radios[num - 1].focus();
                }
            }
        }

        // 4. Language-selection shortcuts.
        if (isScreenVisible(languageSelectionScreen)) {
            if (e.key === '1') simulateClick(modeTwOnlyBtn);
            if (e.key === '2') simulateClick(modeBilingualBtn);
        }

        // 5. Main recording screen shortcuts.
        if (isScreenVisible(mainScreen)) {
            switch(e.key) {
                case ' ': // Space: play video.
                case 'p':
                case 'P':
                    e.preventDefault(); // Prevent page scrolling.
                    toggleVideoPlay();
                    break;
                
                case 'ArrowRight': // Right arrow: next.
                    e.preventDefault();
                    if (finishBtn.style.display !== 'none' && !finishBtn.disabled) {
                        simulateClick(finishBtn);
                    } else {
                        simulateClick(nextBtn);
                    }
                    break;

                case 'ArrowLeft': // Left arrow: previous.
                    e.preventDefault();
                    simulateClick(prevBtn);
                    break;

                case '1': // Number 1: record Taigi.
                case 'r': // R key.
                case 'R':
                    e.preventDefault();
                    const twRecBtn = document.getElementById('btn-record-tw');
                    const twRedoBtn = document.getElementById('btn-redo-tw');
                    if (twRecBtn && twRecBtn.style.display !== 'none') simulateClick(twRecBtn);
                    else if (twRedoBtn && twRedoBtn.style.display !== 'none') simulateClick(twRedoBtn);
                    break;

                case '2': // Number 2: record Mandarin.
                case 'm': // M key.
                case 'M':
                    e.preventDefault();
                    const zhRecBtn = document.getElementById('btn-record-zh');
                    const zhRedoBtn = document.getElementById('btn-redo-zh');
                    if (zhRecBtn && zhRecBtn.style.display !== 'none') simulateClick(zhRecBtn);
                    else if (zhRedoBtn && zhRedoBtn.style.display !== 'none') simulateClick(zhRedoBtn);
                    break;

                case '3': // Number 3: show or hide the Taigi reference sentence.
                case 't':
                case 'T':
                    e.preventDefault();
                    const taigiRefEl = document.getElementById('taigi-reference');
                    if (taigiRefEl) {
                        taigiRefEl.open = !taigiRefEl.open;
                        // Match the visual feedback used by other shortcut buttons.
                        taigiRefEl.querySelector('.taigi-reference-toggle').classList.add('active-key');
                        setTimeout(() => {
                            taigiRefEl.querySelector('.taigi-reference-toggle').classList.remove('active-key');
                        }, 150);
                    }
                    break;
            }
        }
    }

    // --- Dynamic UI functions ---
    function createFluencyItem(langName, formName) { const itemDiv = document.createElement('div'); itemDiv.className = 'fluency-item'; itemDiv.innerHTML = `<div class="lang-name">${langName}</div>`; const optionsDiv = document.createElement('div'); optionsDiv.className = 'fluency-options'; Object.entries(fluencyLevels).forEach(([score, desc]) => { const id = `${formName}_${score}`; optionsDiv.innerHTML += `<label for="${id}"><input type="radio" id="${id}" name="${formName}" value="${score}" required><span class="score">${score}</span><span class="desc">${desc}</span></label>`; }); itemDiv.appendChild(optionsDiv); return itemDiv; }
    function updateFluencyChecklist() { const legend = document.createElement('legend'); legend.textContent = '語言流利程度'; fluencyGroup.innerHTML = ''; fluencyGroup.appendChild(legend); const languages = new Set(); nativeCheckboxes.forEach(cb => { if (cb.checked && cb.value !== '其他') { languages.add(cb.value); } }); if (document.getElementById('native-other-checkbox').checked && nativeOtherText.value.trim()) { languages.add(nativeOtherText.value.trim()); } if (languages.size === 0) { fluencyGroup.innerHTML += '<p style="color:#777; font-size: 14px;">請先在上方選擇您的母語，此處將會顯示對應的評分項目。</p>'; } else { languages.forEach(lang => { const formName = `fluency_${lang.replace(/[\s\(\)]+/g, '')}`; fluencyGroup.appendChild(createFluencyItem(lang, formName)); }); } }
    
    function updateSessionSelectionScreen(isNewUser = false) {
        const totalFinishedGlobally = isNewUser ? 0 : countCompletedSentences(recordingMode);
        const remainingSentences = N - totalFinishedGlobally;
        if (remainingSentences <= 0 && !isNewUser) { sessionSelectionScreen.innerHTML = `<h1>錄製完成</h1><p>恭喜您！您已經完成了所有的 ${N} 句錄音，感謝您的貢獻！</p>`; return; }
        const remainingMinutes = Math.ceil(remainingSentences / 8) * 10;
        const screenTitle = sessionSelectionScreen.querySelector('h1');
        const screenDesc = sessionSelectionScreen.querySelector('p');
        const optionsContainer = sessionSelectionScreen.querySelector('.session-options');
        if (isNewUser) {
            screenTitle.textContent = '選擇錄製時長';
            screenDesc.textContent = '感謝您的時間！請選擇您本次希望參與的錄製長度。';
        } else {
            screenTitle.textContent = '繼續您的錄音';
            screenDesc.textContent = `您已完成 ${totalFinishedGlobally} 句，還剩下 ${remainingSentences} 句 (大約 ${remainingMinutes} 分鐘)。請選擇本次要繼續的長度：`;
        }
        
        const options = [];
        const sentencesPer10Min = 8;
        const maxMinutes = 60;
        for (let min = 10; min <= maxMinutes; min += 10) {
            const count = (min / 10) * sentencesPer10Min;
            if (count < remainingSentences) {
                let labelText = `${min} 分鐘`;
                if (min === 60) labelText = `1 小時`; 
                options.push({ value: count, label: labelText, count: count });
            } else { break; }
        }
        options.push({ value: remainingSentences, label: `完成剩餘部分 (~${remainingMinutes}分鐘)`, count: remainingSentences });

        optionsContainer.innerHTML = '';
        
        options.forEach((opt, idx) => {
            const label = document.createElement('label');
            const radioInput = document.createElement('input'); 
            radioInput.type = 'radio'; 
            radioInput.name = 'sessionDuration'; 
            radioInput.value = opt.value; 
            radioInput.required = true;
            if (idx === 0) radioInput.checked = true; // Select the first option by default for keyboard convenience.
            
            const contentDiv = document.createElement('div'); contentDiv.className = 'session-option-content';
            
            // Update shortcut hints.
            const durationDiv = document.createElement('div'); 
            durationDiv.className = 'duration'; 
            durationDiv.innerHTML = `${opt.label} <span class="key-hint">[按 ${idx + 1}]</span>`;
            
            const countDiv = document.createElement('div'); countDiv.className = 'sentence-count'; countDiv.textContent = `錄製 ${opt.count} 句`;
            contentDiv.appendChild(durationDiv); contentDiv.appendChild(countDiv);
            label.appendChild(radioInput); label.appendChild(contentDiv);
            optionsContainer.appendChild(label);
        });
        startSessionBtn.style.display = 'block';
    }

    function setActiveScreen(nextScreen) {
        [validationScreen, consentScreen, exampleVideoScreen, questionnaireScreen, languageSelectionScreen, sessionSelectionScreen, mainScreen].forEach(screen => {
            if (!screen) return;
            const isTarget = screen === nextScreen;
            screen.style.display = isTarget ? 'block' : 'none';
            screen.classList.toggle('active', isTarget);
        });
        // Pause the example video when leaving its screen so audio does not continue.
        if (nextScreen !== exampleVideoScreen && exampleVideo && !exampleVideo.paused) {
            try { exampleVideo.pause(); } catch (e) {}
        }
    }

    function resetConsentScreenState() {
        if (consentCheckbox) consentCheckbox.checked = false;
        if (agreeBtn) agreeBtn.disabled = true;
        if (consentErrorMsg) consentErrorMsg.textContent = '';
    }

    // --- Core flow functions ---
    async function handleValidation() { 
        if (!validationForm.checkValidity()) { 
            validationForm.reportValidity(); // Show the browser's native validation message.
            return; 
        } 
        
        validateBtn.disabled = true; 
        validateBtn.textContent = '驗證中...'; 
        validationErrorMsg.textContent = ''; 
        
        validationData = { 
            fullName: document.getElementById('full-name').value, 
            contact: document.getElementById('contact').value 
        }; 
        
        try { 
            const response = await fetch('/validate_user', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify(validationData) 
            }); 
            
            const result = await response.json(); 
            if (!response.ok) throw new Error(result.error || '驗證失敗'); 
            
            if (result.status === 'existing_user') { 
                isExistingUser = true; 
                userProfile.userId = result.userId; 
                reconstructRecordings(result.progress); 
                // Existing users go directly to language selection.
                setActiveScreen(languageSelectionScreen);
            } else { 
                isExistingUser = false; 
                // New users review consent first.
                resetConsentScreenState();
                setActiveScreen(consentScreen);
            } 
        } catch (e) { 
            console.error(e);
            validationErrorMsg.textContent = `錯誤: ${e.message}`; 
        } finally { 
            validateBtn.disabled = false; 
            validateBtn.innerHTML = '下一步 <span class="key-hint">[按 Enter]</span>'; 
        } 
    }

    async function handleQuestionnaireSubmit() { if (!questionnaireForm.checkValidity()) { questionnaireErrorMsg.textContent = '請完成所有必填欄位 (包含語言流利度)。'; questionnaireForm.reportValidity(); const firstInvalidFieldset = questionnaireForm.querySelector('fieldset:has(input:invalid)'); if (firstInvalidFieldset) { firstInvalidFieldset.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; } submitQuestionnaireBtn.disabled = true; submitQuestionnaireBtn.textContent = '儲存中...'; questionnaireErrorMsg.textContent = ''; const formData = new FormData(questionnaireForm); const questionnaireData = {}; formData.forEach((value, key) => { if (!questionnaireData[key]) { questionnaireData[key] = value; } else { if (!Array.isArray(questionnaireData[key])) { questionnaireData[key] = [questionnaireData[key]]; } questionnaireData[key].push(value); } }); userProfile = { userId: `${validationData.fullName}_${Date.now()}`, profile: { ...validationData, ...questionnaireData }, deviceInfo: micInfo, submissionTimestamp: new Date().toISOString() }; try { const response = await fetch('/save_profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(userProfile) }); if (!response.ok) { const errorData = await response.json(); throw new Error(errorData.error || '儲存失敗'); } setActiveScreen(languageSelectionScreen); } catch (e) { questionnaireErrorMsg.textContent = `錯誤: ${e.message}`; submitQuestionnaireBtn.disabled = false; submitQuestionnaireBtn.innerHTML = '下一步 <span class="key-hint">[按 Enter]</span>'; } }
    function setupRecordingSession(mode) { recordingMode = mode; updateSessionSelectionScreen(!hasAnyRecording()); setActiveScreen(sessionSelectionScreen); }
    function handleSessionSelection() {
        const selectedOption = sessionForm.querySelector('input[name="sessionDuration"]:checked');
        if (!selectedOption) { sessionErrorMsg.textContent = '請選擇一個錄製時長。'; return; }
        sessionErrorMsg.textContent = '';
        const sentencesToDo = parseInt(selectedOption.value, 10);
        firstUnfinishedIndex = findFirstUnfinished(recordingMode);
        totalSentencesInSession = firstUnfinishedIndex + sentencesToDo;
        currentIndex = firstUnfinishedIndex;
        if (currentIndex >= N) {
            alert("恭喜您已完成所有錄音！");
            setActiveScreen(mainScreen);
            mainScreen.innerHTML = `<h1>錄製完成</h1><p>恭喜您！您已經完成了所有的 ${N} 句錄音，感謝您的貢獻！</p>`;
            return;
        }
        setActiveScreen(mainScreen);
        updateUI();
        // Autoplay the first scenario video with sound, falling back to muted if blocked.
        autoPlayContextVideo();
    }

    // --- Back navigation ---
    btnBackQuestionnaire.addEventListener('click', () => {
        // New users should go from the questionnaire back to the example video.
        if (!isExistingUser) {
            setActiveScreen(exampleVideoScreen);
        } else {
            setActiveScreen(validationScreen);
        }
    });

    btnBackLanguage.addEventListener('click', () => {
        if (isExistingUser) {
            setActiveScreen(validationScreen);
        } else {
            setActiveScreen(questionnaireScreen);
        }
    });

    // Consent form and example video.
    if (btnBackConsent) {
        btnBackConsent.addEventListener('click', () => setActiveScreen(validationScreen));
    }
    if (consentCheckbox && agreeBtn) {
        consentCheckbox.addEventListener('change', () => {
            agreeBtn.disabled = !consentCheckbox.checked;
            if (consentCheckbox.checked && consentErrorMsg) consentErrorMsg.textContent = '';
        });
    }
    if (agreeBtn) {
        agreeBtn.addEventListener('click', () => {
            if (!consentCheckbox || !consentCheckbox.checked) {
                if (consentErrorMsg) consentErrorMsg.textContent = '請先勾選「我已仔細閱讀並同意」';
                return;
            }
            // Store the consent timestamp so it is saved with user_profile.json after the questionnaire.
            validationData.consent = {
                agreed: true,
                agreedAt: new Date().toISOString(),
                userAgent: navigator.userAgent,
                consentDocument: '台語口語倫理審查-REC-S-01研究參與者同意書_v2.pdf',
            };
            setActiveScreen(exampleVideoScreen);
        });
    }
    if (btnBackExample) {
        btnBackExample.addEventListener('click', () => {
            setActiveScreen(consentScreen);
        });
    }
    if (continueFromExampleBtn) {
        continueFromExampleBtn.addEventListener('click', () => {
            setActiveScreen(questionnaireScreen);
            updateFluencyChecklist();
        });
    }

    btnBackSession.addEventListener('click', () => {
        setActiveScreen(languageSelectionScreen);
    });

    btnBackMain.addEventListener('click', () => {
        if (confirm("確定要回到上一頁嗎？目前的錄音進度將會保留，但您需要重新選擇錄製長度。")) {
            stopRecording(); 
            isRecording = false;
            currentRecordingLang = null;
            setActiveScreen(sessionSelectionScreen);
        }
    });

    // --- Click-poster-to-play-video behavior ---
    videoThumbnailContainer.addEventListener('click', () => {
        if (contextVideo.style.display === 'none') {
            videoPoster.style.display = 'none';
            playOverlay.style.display = 'none';
            videoHint.style.display = 'none';
            contextVideo.style.display = 'block';
            contextVideo.play().catch(e => console.error("Video autoplay failed:", e));
        }
    });

    // --- Helper and utility functions ---
    function detectDeviceType() { const ua = navigator.userAgent; if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) { return "Tablet"; } if (/Mobile|iP(hone|od)|Android|BlackBerry|IEMobile|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) { return "Mobile Phone"; } return "Desktop"; };
    function reconstructRecordings(progress) { instances.forEach((item, index) => { const intentId = intentToId[item.intent]; const base_name = `${item.index}_${intentId}`; if (progress[base_name]) { if (progress[base_name].tw) { recordings[index].tw.filename = `${base_name}_tw.wav`; } if (progress[base_name].zh) { recordings[index].zh.filename = `${base_name}_zh.wav`; } } }); }
    function isSentenceComplete(index, mode = recordingMode) { const isTwDone = !!recordings[index]?.tw.filename; const isZhDone = !!recordings[index]?.zh.filename; return mode === 'bilingual' ? (isTwDone && isZhDone) : isTwDone; }
    function hasAnyRecording() { return recordings.some(rec => rec.tw.filename || rec.zh.filename); }
    function countCompletedSentences(mode = recordingMode) { let count = 0; for (let i = 0; i < N; i++) { if (isSentenceComplete(i, mode)) count += 1; } return count; }
    function findFirstUnfinished(mode = recordingMode) { for (let i = 0; i < N; i++) { if (!isSentenceComplete(i, mode)) return i; } return N; }
    
    function updateUI() {
        if (!instances || instances.length === 0 || currentIndex >= N) { mainScreen.innerHTML = `<h1>錄製完成</h1><p>恭喜您！您已經完成了所有的 ${N} 句錄音，感謝您的貢獻！</p>`; return; }
        
        const totalFinishedGlobally = countCompletedSentences(recordingMode);
        const sentencesToDoThisSession = totalSentencesInSession - firstUnfinishedIndex;
        let sentencesDoneThisSession = Math.max(0, currentIndex - firstUnfinishedIndex);
        
        const item = instances[currentIndex];
        const isTwComplete = !!recordings[currentIndex]?.tw.filename;
        const isZhComplete = !!recordings[currentIndex]?.zh.filename;
        const isCurrentComplete = isSentenceComplete(currentIndex);
        if (isCurrentComplete) { sentencesDoneThisSession += 1; }
        
        progressDisplay.textContent = `本次進度: ${sentencesDoneThisSession} / ${sentencesToDoThisSession} 句 (總計已完成: ${totalFinishedGlobally})`;
        
        if (recordingMode === 'tw_only') { 
            recorderZh.style.display = 'none'; 
            scriptInstruction.textContent = '請用 「台語」 表達情境 (鼓勵自由發揮)'; 
        } else { 
            recorderZh.style.display = 'block'; 
            scriptInstruction.textContent = '請分別用 「台語」 和 「國語」 表達情境 (鼓勵自由發揮)'; 
        }
        
        // Update prompt content.
        if (scriptDescription) scriptDescription.textContent = item.description; // Scenario description.
        if (scriptToReadZh) scriptToReadZh.textContent = item.spoken_content; // Mandarin reference sentence.
        if (scriptToReadTw) scriptToReadTw.textContent = item.taigi_content; // Taigi reference sentence.

        // Collapse the Taigi reference on each new sentence so users decide per prompt.
        const taigiRefDetails = document.getElementById('taigi-reference');
        if (taigiRefDetails) taigiRefDetails.open = false;

        // --- Reset video area state ---
        contextVideo.pause();
        contextVideo.currentTime = 0;
        contextVideo.muted = true; // Start muted so only the image is shown.
        contextVideo.style.display = 'none';
        videoPoster.style.display = 'block';
        playOverlay.style.display = 'flex';
        videoHint.style.display = 'block';

        // Use item.index to map directly to video and poster filenames.
        const mediaIndex = item.index;
        contextVideo.src = `videos/${mediaIndex}.mp4`;
        videoPoster.src = `posters/${mediaIndex}.jpg`; 
        videoPoster.onerror = function() { console.log('Image not found for index:', mediaIndex); }; 
        
        ['tw', 'zh'].forEach(lang => {
            const recorder = document.getElementById(`recorder-${lang}`);
            if (!recorder || (recordingMode === 'tw_only' && lang === 'zh')) return;
            const recordBtn = recorder.querySelector(`.btn-record`); const redoBtn = recorder.querySelector(`.btn-redo`); const statusDiv = recorder.querySelector(`.recorder-status`); const playerContainer = recorder.querySelector(`.player-container`); const section = recordBtn.closest('.language-recorder-section');
            playerContainer.innerHTML = '';
            
            // Update button text while preserving keyboard hints.
            const keyHint = lang === 'tw' ? '[按 1]' : '[按 2]';
            recordBtn.disabled = false; 
            recordBtn.innerHTML = `錄製${lang === 'tw' ? '台語' : '國語'} <span class="key-hint">${keyHint}</span>`; 
            recordBtn.classList.remove('recording');
            
            redoBtn.disabled = false;
            redoBtn.innerHTML = `重錄${lang === 'tw' ? '台語' : '國語'} <span class="key-hint">${keyHint}</span>`;

            const currentRec = recordings[currentIndex][lang];
            if (currentRec.filename) {
                recordBtn.style.display = 'none'; redoBtn.style.display = 'block'; statusDiv.querySelector('.status-text').textContent = '已錄製成功。'; statusDiv.querySelector('.mic-icon').classList.remove('recording'); section.classList.remove('incomplete-task');
                if (currentRec.audioURL) { const audio = document.createElement('audio'); audio.controls = true; audio.src = currentRec.audioURL; playerContainer.appendChild(audio); } else { playerContainer.innerHTML = '<p style="font-size: 14px; color: #777;">(此為先前錄音，可直接重錄)</p>'; }
            } else {
                recordBtn.style.display = 'block'; redoBtn.style.display = 'none'; statusDiv.querySelector('.status-text').textContent = `點擊下方按鈕或 ${keyHint} 開始錄音`; statusDiv.querySelector('.mic-icon').classList.remove('recording'); section.classList.add('incomplete-task');
            }
        });
        
        if (isRecording) {
            document.querySelectorAll('.btn-record, .btn-redo').forEach(btn => btn.disabled = true);
            const currentRecordBtn = document.querySelector(`.btn-record[data-lang="${currentRecordingLang}"]`);
            if (currentRecordBtn) {
                if (currentRecordBtn.textContent.includes('停止錄音') || currentRecordBtn.textContent.includes('處理中')) {
                    currentRecordBtn.disabled = false;
                }
            }
        }

        const isSessionGoalReached = findFirstUnfinished(recordingMode) >= totalSentencesInSession;
        if (isSessionGoalReached) { nextBtn.style.display = 'none'; finishBtn.style.display = 'block'; finishBtn.disabled = false; prevBtn.disabled = true; } else { nextBtn.style.display = 'block'; finishBtn.style.display = 'none'; nextBtn.disabled = !isCurrentComplete; }
        prevBtn.disabled = currentIndex <= firstUnfinishedIndex;
    }

    // Strictly validate upload responses before updating the UI.
    async function uploadRecording(blob, lang, ambientNoise) {
        const statusDiv = document.getElementById(`status-${lang}`);
        const statusText = statusDiv.querySelector('.status-text');
        statusText.textContent = '上傳中...';
        
        try {
            const currentItem = instances[currentIndex];
            const formData = new FormData();
            const intentId = intentToId[currentItem.intent];
            const audioExt = audioExtensionForMimeType(micInfo.mimeType);
            const filename = `${currentItem.index}_${intentId}_${lang}.${audioExt}`;
            
            formData.append('audio_file', blob, filename);
            
            const metadata = { 
                userId: userProfile.userId, 
                index: currentItem.index, 
                intent: currentItem.intent, 
                intentId: intentId, 
                language: lang, 
                spoken_content: currentItem.spoken_content, 
                taigi_content: currentItem.taigi_content, 
                recordingInfo: { 
                    label: micInfo.label, 
                    maxPreferredSampleRate: micInfo.maxPreferredSampleRate,
                    requestedSampleRate: micInfo.requestedSampleRate,
                    sampleRate: micInfo.sampleRate, 
                    trackSampleRate: micInfo.trackSampleRate,
                    audioContextSampleRate: micInfo.audioContextSampleRate,
                    sampleRateSource: micInfo.sampleRateSource,
                    sampleRateCapabilities: micInfo.sampleRateCapabilities,
                    channelCount: micInfo.channelCount, 
                    sampleSize: micInfo.sampleSize,
                    mimeType: micInfo.mimeType, 
                    autoGainControl: micInfo.autoGainControl, 
                    noiseSuppression: micInfo.noiseSuppression, 
                    echoCancellation: micInfo.echoCancellation, 
                    ambientNoiseLevel: ambientNoise 
                } 
            };
            formData.append('metadata', JSON.stringify(metadata));

            const response = await fetch('/upload', { method: 'POST', body: formData });

            // Parse JSON.
            let result;
            try {
                result = await response.json();
            } catch (e) {
                throw new Error("無法解析伺服器回應");
            }

            // Check both the HTTP status and the success field in JSON.
            if (!response.ok || !result.success) { 
                const errorMsg = result.error || '未知的伺服器錯誤';
                throw new Error(errorMsg); 
            }

            // Update frontend state only after the server explicitly returns success: true.
            console.log(`Upload succeeded (${lang}):`, result);

            const currentRec = recordings[currentIndex][lang];
            currentRec.filename = result.filename || filename;
            
            if (currentRec.audioURL) { URL.revokeObjectURL(currentRec.audioURL); }
            currentRec.audioURL = URL.createObjectURL(blob);
            
            // Update the UI only after upload success.
            updateUI();

        } catch (error) {
            console.error("Upload failed:", error);
            statusText.textContent = '上傳失敗！';
            
            // Error prompt.
            alert(`【上傳失敗】\n請檢查網路連線或通知管理員。\n錯誤訊息: ${error.message}`);
            // Do not call updateUI here. Keep the item incomplete so the user must retry or re-record.
        } 
    }
    
    async function startRecording(lang) {
        if (isRecording) { alert("另一個錄音正在進行中，請稍候。"); return; }
        isRecording = true;
        currentRecordingLang = lang;
        updateUI(); 
        const statusDiv = document.getElementById(`status-${lang}`);
        const statusText = statusDiv.querySelector('.status-text');
        const recordBtn = document.querySelector(`.btn-record[data-lang="${lang}"]`);
        
        // Update button-state text while preserving the key hint.
        const keyHint = lang === 'tw' ? '[按 1]' : '[按 2]';
        recordBtn.innerHTML = `分析環境音... <span class="key-hint">${keyHint}</span>`;
        statusText.textContent = '請保持安靜 0.1 秒鐘...';
        try {
            activeStream = await getHighFidelityAudioStream();
            const audioTracks = activeStream.getAudioTracks();
            let trackSettings = {};
            if (audioTracks.length > 0) {
                const audioTrack = audioTracks[0];
                const capabilities = getTrackCapabilities(audioTrack);
                const requestedSampleRate = await requestTrackSampleRate(audioTrack, capabilities);
                trackSettings = getTrackSettings(audioTrack);
                micInfo.label = audioTrack.label || 'N/A';
                micInfo.maxPreferredSampleRate = MAX_PREFERRED_SAMPLE_RATE;
                micInfo.requestedSampleRate = requestedSampleRate;
                micInfo.sampleRateCapabilities = capabilities && capabilities.sampleRate ? capabilities.sampleRate : 'N/A';
                micInfo.trackSampleRate = valueOrNA(trackSettings.sampleRate);
                micInfo.channelCount = valueOrNA(trackSettings.channelCount);
                micInfo.sampleSize = valueOrNA(trackSettings.sampleSize);
                micInfo.autoGainControl = valueOrNA(trackSettings.autoGainControl);
                micInfo.noiseSuppression = valueOrNA(trackSettings.noiseSuppression);
                micInfo.echoCancellation = valueOrNA(trackSettings.echoCancellation);
            }
            const audioContext = createAudioContextForTrack(trackSettings);
            micInfo.audioContextSampleRate = audioContext.sampleRate;
            if (micInfo.trackSampleRate !== 'N/A') {
                micInfo.sampleRate = micInfo.trackSampleRate;
                micInfo.sampleRateSource = 'MediaStreamTrack.getSettings()';
            } else {
                micInfo.sampleRate = micInfo.audioContextSampleRate;
                micInfo.sampleRateSource = 'AudioContext.sampleRate';
            }
            const actualSampleRate = Number(micInfo.sampleRate);
            if (window.__TAIGI_LOCAL_WAV_RECORDER__ && actualSampleRate && actualSampleRate < Number(micInfo.requestedSampleRate)) {
                console.warn(`Local recording is currently using an actual sample rate of ${actualSampleRate} Hz, below the requested ${micInfo.requestedSampleRate} Hz. The system will preserve the real sample rate without artificial upsampling.`);
            }
            const source = audioContext.createMediaStreamSource(activeStream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256; const bufferLength = analyser.frequencyBinCount; const dataArray = new Uint8Array(bufferLength); source.connect(analyser);
            const getNoiseLevel = () => { analyser.getByteFrequencyData(dataArray); let sum = 0; for (let i = 0; i < bufferLength; i++) { sum += dataArray[i]; } return sum / bufferLength; };
            const noiseSamples = [];
            const noiseInterval = setInterval(() => { noiseSamples.push(getNoiseLevel()); }, 100);
            audioChunks = [];
            const mimeType = chooseRecorderMimeType();
            micInfo.mimeType = mimeType || 'N/A';
            mediaRecorder = mimeType ? new MediaRecorder(activeStream, { mimeType: micInfo.mimeType }) : new MediaRecorder(activeStream);
            if (mediaRecorder.mimeType) micInfo.mimeType = mediaRecorder.mimeType;
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = () => {
                clearInterval(noiseInterval);
                source.disconnect();
                try { if (audioContext && audioContext.close) { audioContext.close(); } } catch (err) {}
                const averageNoise = noiseSamples.length > 0 ? noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length : 0;
                const audioBlob = new Blob(audioChunks, { type: micInfo.mimeType });
                if (activeStream) { activeStream.getTracks().forEach(track => track.stop()); activeStream = null; }
                isRecording = false;
                currentRecordingLang = null;
                uploadRecording(audioBlob, lang, averageNoise.toFixed(2));
            };
            mediaRecorder.start();
            setTimeout(() => {
                if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
                recordBtn.disabled = false;
                recordBtn.innerHTML = `停止錄音 <span class="key-hint">${keyHint}</span>`;
                statusText.textContent = '錄音中...';
                statusDiv.querySelector('.mic-icon').classList.add('recording');
            }, 100);
        } catch (err) {
            console.error("Unable to start recording:", err);
            alert("無法取得麥克風權限或開始錄音失敗，請重試。");
            if (activeStream) { activeStream.getTracks().forEach(track => track.stop()); activeStream = null; }
            isRecording = false;
            currentRecordingLang = null;
            updateUI();
        }
    }

    function stopRecording() { if (isRecording && mediaRecorder && mediaRecorder.state === "recording") { const recordBtn = document.querySelector(`.btn-record[data-lang="${currentRecordingLang}"]`); const keyHint = currentRecordingLang === 'tw' ? '[按 1]' : '[按 2]'; recordBtn.innerHTML = `處理中... <span class="key-hint">${keyHint}</span>`; recordBtn.disabled = true; mediaRecorder.stop(); } }
    function changeExample(step) { currentIndex = Math.max(0, Math.min(currentIndex + step, N - 1)); updateUI(); }
    
    // --- Event bindings ---
    document.addEventListener('keydown', handleGlobalKeyDown); // Bind global keyboard events.

    validateBtn.addEventListener('click', handleValidation);
    submitQuestionnaireBtn.addEventListener('click', handleQuestionnaireSubmit);
    modeTwOnlyBtn.addEventListener('click', () => setupRecordingSession('tw_only'));
    modeBilingualBtn.addEventListener('click', () => setupRecordingSession('bilingual'));
    startSessionBtn.addEventListener('click', handleSessionSelection);
    
    nativeCheckboxes.forEach(cb => cb.addEventListener('change', updateFluencyChecklist));
    nativeOtherText.addEventListener('input', updateFluencyChecklist);
    document.querySelectorAll('.btn-record').forEach(btn => { btn.addEventListener('click', () => { const lang = btn.dataset.lang; if (isRecording && currentRecordingLang === lang) { stopRecording(); } else if (!isRecording) { startRecording(lang); } }); });
    document.querySelectorAll('.btn-redo').forEach(btn => { btn.addEventListener('click', () => { const lang = btn.dataset.lang; if (isRecording) { alert("另一個錄音正在進行中，無法重錄。"); return; } if (confirm(`確定要重新錄製這句的【${lang === 'tw' ? '台語' : '國語'}】嗎？`)) { const rec = recordings[currentIndex][lang]; if (rec.audioURL) { URL.revokeObjectURL(rec.audioURL); } rec.filename = null; rec.audioURL = null; updateUI(); } }); });
    prevBtn.addEventListener('click', () => { if (currentIndex > firstUnfinishedIndex) { changeExample(-1); } });
    nextBtn.addEventListener('click', () => {
        const currentRecs = recordings[currentIndex];
        const isComplete = recordingMode === 'bilingual' ? (currentRecs.tw.filename && currentRecs.zh.filename) : currentRecs.tw.filename;
        if (!isComplete) { alert('請先完成目前句子的錄音，才能前往下一句。'); return; }
        const beforeIndex = currentIndex;
        changeExample(1);
        if (currentIndex !== beforeIndex) {
            // Autoplay only after the index actually advances, avoiding replay on the last item.
            autoPlayContextVideo();
        }
    });
    finishBtn.addEventListener('click', () => { alert('感謝您！本次錄音已完成。\n您可以關閉此頁面，或重新整理以開始新的錄製會話。'); finishBtn.disabled = true; prevBtn.disabled = true; });
    validationForm.addEventListener('submit', e => e.preventDefault());
    questionnaireForm.addEventListener('submit', e => e.preventDefault());
    sessionForm.addEventListener('submit', e => e.preventDefault());

    // --- Entry point ---
    async function initialize() { validateBtn.disabled = true; validateBtn.textContent = "資料載入中..."; micInfo.deviceType = detectDeviceType(); try { await loadData(); console.log("Prompt data loaded successfully."); validateBtn.disabled = false; validateBtn.innerHTML = '下一步 <span class="key-hint">[按 Enter]</span>'; } catch (error) { console.error("Initialization failed:", error); validateBtn.textContent = "載入失敗，請重整"; validationErrorMsg.textContent = "無法載入錄音所需資料，請檢查網路連線並重新整理頁面。"; } }
    async function fetchAvailableVideoIndices() {
        const response = await fetch('/available_video_indices');
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();
        if (!result.success || !Array.isArray(result.indices)) throw new Error('無效的影片索引回應');
        return result.indices;
    }
    async function loadData() { 
        // Use the current JSON data file.
        const response = await fetch('gemini_2026_pro_preview_0121_160_data_proof.json'); 
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`); 
        let originalInstances = await response.json(); 
        function reorderInterleaved(items) { const groups = {}; items.forEach(item => { if (!groups[item.intent]) { groups[item.intent] = []; } groups[item.intent].push(item); }); for (const intent in groups) { groups[intent].sort((a, b) => a.index.localeCompare(b.index)); } const reordered = []; const intentOrder = Object.keys(groups); const maxPerIntent = Math.max(0, ...intentOrder.map(intent => groups[intent].length)); for (let i = 0; i < maxPerIntent; i++) { for (const intent of intentOrder) { if (groups[intent] && groups[intent][i]) { reordered.push(groups[intent][i]); } } } return reordered; } 
        const availableVideoIndices = await fetchAvailableVideoIndices();
        let filteredInstances = reorderInterleaved(originalInstances);
        if (!availableVideoIndices || availableVideoIndices.length === 0) {
            throw new Error('找不到可用的影片索引，請先確認 videos 目錄有 4 碼 index 命名的 mp4 檔案。');
        }
        const availableSet = new Set(availableVideoIndices);
        // Keep every script item that has a matching video index.
        filteredInstances = filteredInstances.filter(item => availableSet.has(item.index));
        if (filteredInstances.length === 0) {
            throw new Error('找不到可用的影片資料，請先確認 videos 目錄內有 4 碼 index 命名的 mp4 檔案。');
        }
        instances = filteredInstances;
        N = instances.length; 
        recordings = Array(N).fill(null).map(() => ({ tw: { filename: null, audioURL: null }, zh: { filename: null, audioURL: null } })); 
    }

    initialize();
})();
