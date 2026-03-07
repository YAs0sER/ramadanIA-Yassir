/* ══════════════════════════════════════════════════
   YASSIR — يسّر  |  app.js
   Language: Darija only
   STT/TTS: Azure Speech Services
   Intent/Extract: Azure OpenAI
   ══════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════
   1. AZURE CONFIGURATION
   ══════════════════════════════════════════════════ */

const AzureConfig = {
  speech: {
    key:         'G5GNraeXCEKDcIGESESWYG82CWjfEi9xpKkdiPS68Qytvu0CUummJQQJ99CCAC5RqLJXJ3w3AAAYACOGsBVL',
    region:      'westeurope',            // e.g. 'westeurope'
    sttLanguage: 'ar-MA',                  // Arabic Morocco — best for Darija
    ttsVoice:    'ar-EG-ShakirNeural',      // Male Moroccan voice
    // Alternative: 'ar-MA-MounaNeural'   // Female Moroccan voice

  },
  openai: {
    endpoint:   'https://yassi-mmgmfz3c-eastus2.cognitiveservices.azure.com/', // e.g. 'https://xxxx.openai.azure.com/'
    key:        '6s42tD92O4sgQRJ0z1jEkdiYDEwGbbjRBCvRpuLblxDU5j0a6oRiJQQJ99CCACHYHv6XJ3w3AAAAACOGRe8m',
    deployment: 'gpt-4o',
    apiVersion: '2024-04-01-preview',
  }
};


/* ══════════════════════════════════════════════════
   2. AZURE SERVICES
   ══════════════════════════════════════════════════ */

const AzureServices = (() => {

  /* ── SPEECH TO TEXT ── */
  function startSTT(onResult, onInterim) {
    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
      AzureConfig.speech.key,
      AzureConfig.speech.region
    );

// Force Arabic Morocco — prevents fallback to English transcription
    speechConfig.speechRecognitionLanguage = AzureConfig.speech.sttLanguage;

    // Disable automatic language detection so it stays on ar-MA
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
      'Disabled'
    );

    // Tell the service to output Arabic script only
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceResponse_TranslationRequestStablePartialResult,
      'false'
    );

    // Explicit output format — detailed gives us language confidence too
    speechConfig.outputFormat = SpeechSDK.OutputFormat.Detailed;



    const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
    const recognizer  = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

    recognizer.recognizing = (_s, e) => {
      if (e.result.text) onInterim(e.result.text);
    };

    recognizer.recognized = (_s, e) => {
      if (
        e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech &&
        e.result.text
      ) {
        recognizer.stopContinuousRecognitionAsync();
        onResult(e.result.text);
      }
    };

    recognizer.canceled = (_s, e) => {
      console.warn('[STT] Canceled:', e.errorDetails);
      recognizer.stopContinuousRecognitionAsync();
      onResult(null);
    };

    recognizer.startContinuousRecognitionAsync(
      ()    => console.log('[STT] Listening started'),
      (err) => { console.error('[STT] Start error:', err); onResult(null); }
    );

    return {
      stop: () => recognizer.stopContinuousRecognitionAsync()
    };
  }


  /* ── TEXT TO SPEECH ──
     Removes punctuation before synthesis so Azure
     does not read symbols aloud (no "virgule", "point", etc.)
  ── */
  function cleanForTTS(text) {
    return text
      .replace(/[؟?!،,\.。:;«»""''()\[\]{}\-_\/\\|@#$%^&*+=<>~`]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async function speak(text) {
    const clean = cleanForTTS(text);
    if (!clean) return;

    const speechConfig = SpeechSDK.SpeechConfig.fromSubscription(
      AzureConfig.speech.key,
      AzureConfig.speech.region
    );
    speechConfig.speechSynthesisVoiceName = AzureConfig.speech.ttsVoice;

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-MA">
  <voice name="${AzureConfig.speech.ttsVoice}">
    <prosody rate="0.9" pitch="0%">${clean}</prosody>
  </voice>
</speak>`;

    const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig);

    return new Promise((resolve) => {
      synthesizer.speakSsmlAsync(
        ssml,
        result => {
          synthesizer.close();
          if (result.reason !== SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.warn('[TTS] Issue:', result.errorDetails);
          }
          resolve();
        },
        err => {
          console.error('[TTS] Error:', err);
          synthesizer.close();
          resolve();
        }
      );
    });
  }


  /* ── INTENT DETECTION ── */
  async function detectIntent(transcript) {
    const url = `${AzureConfig.openai.endpoint}openai/deployments/${AzureConfig.openai.deployment}/chat/completions?api-version=${AzureConfig.openai.apiVersion}`;

    const system = `أنت مساعد إداري مغربي والمستخدم كيتكلم بالدارجة المغربية
مهمتك تحدد الخدمة الإدارية لي بغاها المستخدم
رجع فقط JSON بلا أي نص زيادة
{ "intent": "<service_key>", "confidence": <0-1> }

الخدمات المتاحة
attestation شهادة السكنى باش يثبت السكنى
naissance شهادة الازدياد
cin تجديد البطاقة الوطنية منتهية أو ضايعة
revenu شهادة الدخل باش يثبت الدخل
unknown ما فهمتش

أمثلة
بغيت شهادة السكنى يعطي intent attestation confidence 0.97
محتاج نجدد البطاقة يعطي intent cin confidence 0.95
بغيت شهادة الازدياد يعطي intent naissance confidence 0.96
محتاج شهادة الدخل يعطي intent revenu confidence 0.94`;

    try {
      const res  = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': AzureConfig.openai.key,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: transcript }
          ],
          max_tokens: 60,
          temperature: 0,
        })
      });
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content.trim());
    } catch (err) {
      console.error('[OpenAI] detectIntent error:', err);
      return { intent: 'unknown', confidence: 0 };
    }
  }


  /* ── FIELD VALUE EXTRACTION ── */
  async function extractFieldValue(transcript, fieldKey, fieldLabel) {
    const url = `${AzureConfig.openai.endpoint}openai/deployments/${AzureConfig.openai.deployment}/chat/completions?api-version=${AzureConfig.openai.apiVersion}`;

    const rules = {
      nom:      'الاسم الكامل اكتبو بالحروف الكبيرة مثلا Mohammed Al Fassi',
      cin:      'رقم البطاقة الوطنية حروف كبيرة وأرقام فقط مثلا AB123456',
      adr:      'العنوان الكامل كما قاله',
      ville:    'اسم المدينة فقط',
      tel:      'رقم الهاتف أرقام فقط تبدأ ب 06 أو 07 أو 05',
      naissance:'تاريخ الميلاد بصيغة DD/MM/YYYY',
      lieu:     'مكان الازدياد اسم المدينة أو المنطقة',
      motif:    'سبب التجديد باختصار',
      emploi:   'اسم الشركة أو المؤسسة',
      salaire:  'الرقم فقط بلا عملة',
    };

    const rule = rules[fieldKey] || fieldLabel;

    const system = `أنت مساعد إداري مغربي والمستخدم كيتكلم بالدارجة
استخرج قيمة الحقل من كلام المستخدم
الحقل ${rule}
رجع فقط JSON بلا أي نص زيادة
{ "value": "<القيمة>", "confidence": <0-1> }
إلا ما فهمتيش رجع { "value": null, "confidence": 0 }`;

    try {
      const res  = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': AzureConfig.openai.key,
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: transcript }
          ],
          max_tokens: 80,
          temperature: 0,
        })
      });
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content.trim());
    } catch (err) {
      console.error('[OpenAI] extractFieldValue error:', err);
      return { value: null, confidence: 0 };
    }
  }

  return { startSTT, speak, detectIntent, extractFieldValue };

})();


/* ══════════════════════════════════════════════════
   3. SERVICE DEFINITIONS — Darija only
   ══════════════════════════════════════════════════ */

const SERVICES = {
  attestation: {
    title:    'شهادة السكنى',
    badge:    'Attestation de résidence',
    url:      'portail.ma/commune/attestation-residence',
    greeting: 'واخا سنعاونك فشهادة السكنى هيا نبداو',
    fields: [
      { key: 'nom',   label: 'NOM COMPLET', ar: 'الاسم الكامل', hint: 'محمد الفاسي',              question: 'شنو هو اسمك الكامل' },
      { key: 'cin',   label: 'N° CIN',       ar: 'رقم البطاقة',  hint: 'AB123456',                 question: 'شنو هو رقم بطاقتك الوطنية' },
      { key: 'adr',   label: 'ADRESSE',      ar: 'العنوان',      hint: 'شارع الحسن الثاني رقم 12', question: 'شنو هو عنوانك' },
      { key: 'ville', label: 'VILLE',        ar: 'المدينة',      hint: 'خريبكة',                   question: 'فأي مدينة كاتسكن' },
      { key: 'tel',   label: 'TÉLÉPHONE',    ar: 'رقم الهاتف',   hint: '0612345678',               question: 'شنو هو رقم تيليفونك' },
    ]
  },
  naissance: {
    title:    'شهادة الميلاد',
    badge:    'Acte de naissance',
    url:      'portail.ma/etat-civil/naissance',
    greeting: 'واخا سنعاونك فشهادة الازدياد هيا نبداو',
    fields: [
      { key: 'nom',       label: 'NOM COMPLET',   ar: 'الاسم الكامل',  hint: 'محمد الفاسي', question: 'شنو هو اسمك الكامل' },
      { key: 'cin',       label: 'N° CIN',         ar: 'رقم البطاقة',   hint: 'AB123456',     question: 'شنو هو رقم بطاقتك الوطنية' },
      { key: 'naissance', label: 'DATE NAISSANCE', ar: 'تاريخ الميلاد', hint: '15/03/1985',   question: 'فوقاش ولدتي شنو هو تاريخ ميلادك' },
      { key: 'lieu',      label: 'LIEU NAISSANCE', ar: 'مكان الازدياد', hint: 'خريبكة',       question: 'فأي مدينة ولدتي' },
      { key: 'tel',       label: 'TÉLÉPHONE',      ar: 'رقم الهاتف',    hint: '0612345678',   question: 'شنو هو رقم تيليفونك' },
    ]
  },
  cin: {
    title:    'تجديد البطاقة الوطنية',
    badge:    'Renouvellement CIN',
    url:      'portail.ma/cin/renouvellement',
    greeting: 'واخا سنعاونك فتجديد البطاقة الوطنية هيا نبداو',
    fields: [
      { key: 'nom',   label: 'NOM COMPLET',   ar: 'الاسم الكامل',        hint: 'محمد الفاسي',   question: 'شنو هو اسمك الكامل' },
      { key: 'cin',   label: 'ANCIEN N° CIN', ar: 'رقم البطاقة القديمة', hint: 'AB123456',       question: 'شنو هو رقم بطاقتك القديمة' },
      { key: 'motif', label: 'MOTIF',         ar: 'سبب التجديد',         hint: 'منتهية الصلاحية', question: 'علاش بغيتي تجدد البطاقة شنو هو السبب' },
      { key: 'ville', label: 'VILLE',         ar: 'المدينة',             hint: 'خريبكة',         question: 'فأي مدينة كاتسكن' },
      { key: 'tel',   label: 'TÉLÉPHONE',     ar: 'رقم الهاتف',          hint: '0612345678',     question: 'شنو هو رقم تيليفونك' },
    ]
  },
  revenu: {
    title:    'شهادة الدخل',
    badge:    'Attestation de revenu',
    url:      'portail.ma/emploi/revenu',
    greeting: 'واخا سنعاونك فشهادة الدخل هيا نبداو',
    fields: [
      { key: 'nom',     label: 'NOM COMPLET',  ar: 'الاسم الكامل',  hint: 'محمد الفاسي', question: 'شنو هو اسمك الكامل' },
      { key: 'cin',     label: 'N° CIN',        ar: 'رقم البطاقة',   hint: 'AB123456',     question: 'شنو هو رقم بطاقتك الوطنية' },
      { key: 'emploi',  label: 'EMPLOYEUR',     ar: 'جهة العمل',     hint: 'OCP خريبكة',   question: 'فأي شركة أو مؤسسة كاتخدم' },
      { key: 'salaire', label: 'SALAIRE (MAD)', ar: 'الراتب الشهري', hint: '5000',          question: 'شحال هو الراتب الشهري ديالك' },
      { key: 'tel',     label: 'TÉLÉPHONE',     ar: 'رقم الهاتف',    hint: '0612345678',   question: 'شنو هو رقم تيليفونك' },
    ]
  }
};


/* ══════════════════════════════════════════════════
   4. APP STATE
   ══════════════════════════════════════════════════ */

const AppState = {
  phase:        'idle',
  service:      null,
  fieldIndex:   0,
  currentField: null,
  answers:      {},
  sttHandle:    null,
  startTime:    null,
};


/* ══════════════════════════════════════════════════
   5. FORM MANAGER
   ══════════════════════════════════════════════════ */

const FormManager = {

  render(serviceKey) {
    const svc       = SERVICES[serviceKey];
    const container = document.getElementById('form-fields-container');
    container.innerHTML = '';

    svc.fields.forEach((field, i) => {
      const group = document.createElement('div');
      group.className = 'field-group';
      group.id        = `field-group-${field.key}`;
      group.innerHTML = `
        <div class="field-label-row">
          <span class="field-label">${field.label}</span>
          <span class="field-ar-label">${field.ar}</span>
        </div>
        <div class="field-wrap">
          <input
            type="text"
            id="field-${field.key}"
            name="${field.key}"
            class="field-input"
            placeholder="${field.hint}"
            autocomplete="off"
            data-index="${i}"
          />
        </div>`;
      container.appendChild(group);
    });

    document.getElementById('form-title').textContent = svc.title;
    document.getElementById('form-badge').textContent = svc.badge;
    document.getElementById('browser-url').textContent = svc.url;
    this.updateProgress(serviceKey, 0);
  },

  fillField(fieldKey, value) {
    const input = document.getElementById(`field-${fieldKey}`);
    if (!input) return;
    input.value = value;
    input.classList.remove('active-field');
    input.classList.add('filled');
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  setActiveField(fieldKey) {
    document.querySelectorAll('.field-input').forEach(el => el.classList.remove('active-field'));
    const input = document.getElementById(`field-${fieldKey}`);
    if (input && !input.classList.contains('filled')) {
      input.classList.add('active-field');
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  },

  updateProgress(serviceKey, filledCount) {
    const total = SERVICES[serviceKey].fields.length;
    const pct   = total > 0 ? Math.round((filledCount / total) * 100) : 0;
    document.getElementById('form-progress-fill').style.width  = pct + '%';
    document.getElementById('form-progress-label').textContent = `${filledCount} / ${total}`;
    document.getElementById('form-submit-btn').disabled        = filledCount < total;
  },

  collect() {
    return new FormData(document.getElementById('admin-form'));
  },

  filledCount(serviceKey) {
    return SERVICES[serviceKey].fields.filter(f => {
      const el = document.getElementById(`field-${f.key}`);
      return el && el.value.trim().length > 0;
    }).length;
  }
};


/* ══════════════════════════════════════════════════
   6. VOICE FLOW ORCHESTRATOR
   ══════════════════════════════════════════════════ */

const VoiceFlow = {

  async greet() {
    AppState.phase = 'greeting';
    UI.setStatus('processing', 'مرحبا');
    UI.setFooterStrip('', 'مرحبا بيك في يسّر');
    await AzureServices.speak('مرحبا بيك، شنو تبغي تدير اليوم؟');
    await this.listenForIntent();
  },

  async listenForIntent() {
    AppState.phase        = 'listening-intent';
    AppState.currentField = null;

    UI.showState('state-listening');
    UI.setStatus('listening', 'كنسمع');
    UI.setMicState('listening');
    UI.setFooterStrip('listening', 'كنسمعك تكلم دابا');

    const transcript = await this._listenOnce(interim => {
      const box = document.getElementById('live-transcript');
      box.innerHTML = interim + '<span class="transcript-cursor">|</span>';
    });

    if (!transcript) {
      await AzureServices.speak('ما سمعتكش عاود حاول');
      this.listenForIntent();
      return;
    }

    document.getElementById('live-transcript').textContent = transcript;
    UI.setFooterStrip('processing', transcript);
    UI.showState('state-processing');
    UI.setStatus('processing', 'كنفهم');
    UI.setMicState('processing');

    const { intent, confidence } = await AzureServices.detectIntent(transcript);

    if (!SERVICES[intent] || confidence < 0.5) {
      await AzureServices.speak('ما فهمتكش قول ليا مثلا شهادة السكنى ولا تجديد البطاقة');
      this.listenForIntent();
      return;
    }

    this.startServiceFlow(intent);
  },

  async startServiceFlow(serviceKey) {
    AppState.service    = serviceKey;
    AppState.fieldIndex = 0;
    AppState.answers    = {};
    AppState.startTime  = Date.now();

    const svc = SERVICES[serviceKey];
    FormManager.render(serviceKey);
    UI.showState('state-form');
    UI.setBrowserUrl(svc.url, true);
    UI.setHeaderContext(svc.title);
    UI.setStatus('processing', svc.title);

    await AzureServices.speak(svc.greeting);
    await this.collectNextField();
  },

  async collectNextField() {
    const svc = SERVICES[AppState.service];

    if (AppState.fieldIndex >= svc.fields.length) {
      await this.finishForm();
      return;
    }

    const field           = svc.fields[AppState.fieldIndex];
    AppState.currentField = field.key;
    AppState.phase        = 'listening-field';

    UI.setVoiceQuestion(`${field.label} — ${field.ar}`, field.question);
    FormManager.setActiveField(field.key);
    UI.showTextFallback(true);
    document.getElementById('text-input').placeholder = field.hint;

    await AzureServices.speak(field.question);

    UI.setStatus('listening', field.label);
    UI.setMicState('listening');
    UI.setFooterStrip('listening', field.question);

    const transcript = await this._listenOnce(
      interim => UI.setFooterStrip('listening', interim)
    );

    if (!transcript) {
      await AzureServices.speak('ما سمعتكش عاود جاوب');
      this.collectNextField();
      return;
    }

    UI.setMicState('processing');
    UI.setStatus('processing', 'كنفهم');

    const { value, confidence } = await AzureServices.extractFieldValue(
      transcript, field.key, field.label
    );

    if (!value || confidence < 0.5) {
      await AzureServices.speak('ما فهمتش مزيان عاود قول');
      this.collectNextField();
      return;
    }

    // Inject value into form field via FormData pattern
    AppState.answers[field.key] = value;
    FormManager.fillField(field.key, value);
    FormManager.updateProgress(AppState.service, FormManager.filledCount(AppState.service));

    UI.setFooterStrip('success', `${field.label} ${value}`);
    UI.setMicState('idle');
    UI.setStatus('ready', 'مزيان');

    await AzureServices.speak('مزيان ' + value);

    await delay(300);
    AppState.fieldIndex++;
    this.collectNextField();
  },

  async finishForm() {
    AppState.phase = 'done';
    UI.setStatus('ready', 'واخا');
    UI.showTextFallback(false);
    UI.setFooterStrip('success', 'تم جمع كل المعلومات');
    UI.setMicState('idle');
    UI.setVoiceQuestion('', 'واخا ضغط على زر الإرسال');
    document.getElementById('form-submit-btn').scrollIntoView({ behavior: 'smooth' });
    await AzureServices.speak('مزيان تم جمع كل المعلومات ضغط على زر الإرسال');
  },

  _listenOnce(onInterim) {
    return new Promise(resolve => {
      const handle = AzureServices.startSTT(
        result  => resolve(result),
        interim => onInterim && onInterim(interim)
      );
      AppState.sttHandle = handle;
    });
  },

  stopListening() {
    if (AppState.sttHandle?.stop) {
      AppState.sttHandle.stop();
      AppState.sttHandle = null;
    }
  }
};


/* ══════════════════════════════════════════════════
   7. UI CONTROLLER
   ══════════════════════════════════════════════════ */

const UI = {

  showState(id) {
    document.querySelectorAll('.main-state').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  },

  setStatus(type, label) {
    document.getElementById('status-dot').className   = 'status-dot ' + (type === 'ready' ? '' : type);
    document.getElementById('status-label').textContent = label;
  },

  setMicState(state) {
    const btn   = document.getElementById('mic-btn');
    const dflt  = document.getElementById('mic-icon-default');
    const stop  = document.getElementById('mic-icon-stop');
    const label = document.getElementById('mic-label');
    const bars  = document.querySelectorAll('.fw-bar');

    btn.className = 'mic-btn';

    if (state === 'listening') {
      btn.classList.add('listening');
      dflt.style.display = 'none';
      stop.style.display = 'block';
      label.textContent  = 'اضغط باش توقف';
      label.style.color  = '#ef4444';
      bars.forEach(b => b.classList.add('active'));
    } else if (state === 'processing') {
      btn.classList.add('processing');
      dflt.style.display = 'block';
      stop.style.display = 'none';
      label.textContent  = 'كنفهم';
      label.style.color  = '#b45309';
      bars.forEach(b => b.classList.remove('active'));
    } else {
      dflt.style.display = 'block';
      stop.style.display = 'none';
      label.textContent  = 'اضغط وتكلم';
      label.style.color  = '';
      bars.forEach(b => b.classList.remove('active'));
    }
  },

  setFooterStrip(type, text) {
    document.getElementById('footer-strip').className        = 'footer-strip ' + (type || '');
    document.getElementById('footer-strip-text').textContent = text;
  },

  setBrowserUrl(url, loading = false) {
    const el     = document.getElementById('browser-url');
    const loader = document.getElementById('browser-loader');
    el.textContent = url;
    el.classList.toggle('loaded', !loading);
    loader.classList.toggle('loading', loading);
    if (loading) {
      setTimeout(() => {
        loader.classList.remove('loading');
        el.classList.add('loaded');
      }, 1200);
    }
  },

  setHeaderContext(text) {
    const el = document.getElementById('header-context');
    el.textContent = text;
    el.classList.add('active-context');
  },

  setVoiceQuestion(fieldLabel, question) {
    document.getElementById('vq-field-label').textContent = fieldLabel;
    document.getElementById('vq-question').textContent    = question;
  },

  showTextFallback(show) {
    document.getElementById('text-fallback').style.display = show ? 'flex' : 'none';
    if (show) setTimeout(() => document.getElementById('text-input').focus(), 100);
  },

  toast(msg, duration = 2500) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.style.display = 'none', duration);
  }
};


/* ══════════════════════════════════════════════════
   8. EVENT HANDLERS
   ══════════════════════════════════════════════════ */

function handleMicPress() {
  const phase = AppState.phase;

  if (phase === 'listening-intent' || phase === 'listening-field') {
    VoiceFlow.stopListening();
    UI.setMicState('idle');
    UI.setFooterStrip('', 'اضغط وتكلم');
    AppState.phase = 'idle';
    return;
  }

  if (phase === 'idle' || phase === 'done') {
    VoiceFlow.greet();
  }
}

function selectService(serviceKey) {
  VoiceFlow.stopListening();
  VoiceFlow.startServiceFlow(serviceKey);
}

function submitTextInput() {
  const input = document.getElementById('text-input');
  const val   = input.value.trim();
  if (!val) return;

  const phase = AppState.phase;

  if (phase === 'listening-intent' || phase === 'idle') {
    VoiceFlow.stopListening();
    UI.showState('state-processing');
    UI.setMicState('processing');
    AzureServices.detectIntent(val).then(({ intent, confidence }) => {
      if (SERVICES[intent] && confidence >= 0.5) {
        VoiceFlow.startServiceFlow(intent);
      } else {
        UI.toast('ما فهمتكش عاود حاول');
        UI.showState('state-idle');
        UI.setMicState('idle');
      }
    });

  } else if (phase === 'listening-field') {
    VoiceFlow.stopListening();
    const field = SERVICES[AppState.service].fields[AppState.fieldIndex];
    if (!field) return;

    AzureServices.extractFieldValue(val, field.key, field.label).then(({ value, confidence }) => {
      if (!value || confidence < 0.5) { UI.toast('ما فهمتش عاود'); return; }
      AppState.answers[field.key] = value;
      FormManager.fillField(field.key, value);
      FormManager.updateProgress(AppState.service, FormManager.filledCount(AppState.service));
      UI.setFooterStrip('success', `${field.label} ${value}`);
      AppState.fieldIndex++;
      input.value = '';
      setTimeout(() => VoiceFlow.collectNextField(), 300);
    });
  }

  input.value = '';
}

async function handleFormSubmit(e) {
  e.preventDefault();

  // Collect all fields via FormData API
  const fd      = FormManager.collect();
  const payload = {};
  for (const [key, value] of fd.entries()) payload[key] = value;
  console.log('[Yassir] FormData payload:', payload);

  /*
   * SUBMIT TO BACKEND — uncomment and adapt:
   *
   * await fetch('/api/submit', {
   *   method: 'POST',
   *   headers: { 'Content-Type': 'application/json' },
   *   body: JSON.stringify(payload)
   * });
   */

  const btn = document.getElementById('form-submit-btn');
  btn.innerHTML = `<div style="width:20px;height:20px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;"></div><span>كنرسل</span>`;
  btn.style.gap = '10px';
  btn.disabled  = true;

  await delay(1600);

  const elapsed = AppState.startTime ? Math.round((Date.now() - AppState.startTime) / 1000) : 0;
  const saved   = Math.max(15 - Math.round(elapsed / 60), 2);

  document.getElementById('sc-number').textContent = 'YSR-2026-' + (4800 + Math.floor(Math.random() * 200));
  document.getElementById('st-time').textContent   = 'وفرتي ' + saved + ' دقيقة';

  UI.showState('state-success');
  UI.setStatus('ready', 'تم');
  UI.setFooterStrip('success', 'تم إرسال الطلب بنجاح');

  await AzureServices.speak('مزيان تم إرسال طلبك غادي يوصلك رقم المتابعة');
}

function resetApp() {
  AppState.phase        = 'idle';
  AppState.service      = null;
  AppState.fieldIndex   = 0;
  AppState.answers      = {};
  AppState.currentField = null;
  AppState.startTime    = null;

  UI.showState('state-idle');
  UI.setMicState('idle');
  UI.setStatus('ready', 'واخا');
  UI.setFooterStrip('', 'اضغط وتكلم');
  UI.showTextFallback(false);

  const ctx = document.getElementById('header-context');
  ctx.textContent = 'مساعدك الإداري الذكي';
  ctx.classList.remove('active-context');

  const btn = document.getElementById('form-submit-btn');
  if (btn) {
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>إرسال الطلب`;
    btn.disabled  = true;
  }
}


/* ══════════════════════════════════════════════════
   9. HELPERS
   ══════════════════════════════════════════════════ */

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/* ══════════════════════════════════════════════════
   10. INIT — auto-greet on page load
   ══════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => VoiceFlow.greet(), 800);
});
