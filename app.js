/* ══════════════════════════════════════════════════
   YASSIR — يسّر  |  app.js  v6
   FIXES:
   1. Numbers: full fuzzy (جوج=2, صفر=0, etc.) + GPT closest-number
   2. Phone/earpiece: AudioContext playback mode forces loudspeaker
   3. Yes/No confirmation timeout (3s silence → auto-accept)
   4. Responsive desktop layout (see style.css)
   5. بغيت نبدل — detect change intent, go back 1 field
   6. All forms: separate NOM + PRÉNOM (no more isFullName)
   7. Arabic names: always Arabic script in AR field, fuzzy-matched
   ══════════════════════════════════════════════════ */

'use strict';

const AzureConfig = {
  speech: {
    key:       'G5GNraeXCEKDcIGESESWYG82CWjfEi9xpKkdiPS68Qytvu0CUummJQQJ99CCAC5RqLJXJ3w3AAAYACOGsBVL',
    region:    'westeurope',
    sttLangAR: 'ar-MA',
    sttLangFR: 'fr-FR',
    ttsVoice:  'ar-EG-ShakirNeural',
  },
  openai: {
    endpoint:   'https://yassi-mmgmfz3c-eastus2.cognitiveservices.azure.com/',
    key:        '6s42tD92O4sgQRJ0z1jEkdiYDEwGbbjRBCvRpuLblxDU5j0a6oRiJQQJ99CCACHYHv6XJ3w3AAAAACOGRe8m',
    deployment: 'gpt-4o',
    apiVersion: '2024-04-01-preview',
  }
};

/* ── AUDIO ROUTER: force loudspeaker on mobile (avoids earpiece/call mode) ── */
const AudioRouter = (() => {
  let _ctx = null;
  function init() {
    try {
      _ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback', sampleRate: 44100 });
      const buf = _ctx.createBuffer(1, 1, 44100);
      const src = _ctx.createBufferSource();
      src.buffer = buf;
      src.connect(_ctx.destination);
      src.start(0);
    } catch(e) { console.warn('[AudioRouter]', e); }
  }
  function unlock() {
    if (!_ctx) init();
    if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(()=>{});
  }
  return { init, unlock };
})();

/* ── TTS QUEUE ── */
const TTSQueue = (() => {
  let _chain = Promise.resolve(), _active = null, _skip = false;
  function speak(text) { _chain = _chain.then(() => _skip ? Promise.resolve() : _synth(text)); return _chain; }
  function cancel() { _skip=true; if(_active){try{_active.close();}catch(_){}_active=null;} _chain=Promise.resolve(); setTimeout(()=>{_skip=false;},80); }
  function _clean(t) { return t.replace(/[؟?!،,\.。:;«»""''()\[\]{}\-_\/\\|@#$%^&*+=<>~`]/g,' ').replace(/\s{2,}/g,' ').trim(); }
  function _synth(text) {
    const clean = _clean(text); if (!clean) return Promise.resolve();
    const cfg = SpeechSDK.SpeechConfig.fromSubscription(AzureConfig.speech.key, AzureConfig.speech.region);
    cfg.speechSynthesisVoiceName = AzureConfig.speech.ttsVoice;
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-MA"><voice name="${AzureConfig.speech.ttsVoice}"><prosody rate="0.92" pitch="0%">${clean}</prosody></voice></speak>`;
    const s = new SpeechSDK.SpeechSynthesizer(cfg);
    _active = s;
    return new Promise(resolve => { s.speakSsmlAsync(ssml, ()=>{_active=null;s.close();resolve();}, ()=>{_active=null;s.close();resolve();}); });
  }
  return { speak, cancel };
})();

/* ── STT ── */
const AzureSTT = (() => {
  function _makeRec(lang) {
    const cfg = SpeechSDK.SpeechConfig.fromSubscription(AzureConfig.speech.key, AzureConfig.speech.region);
    cfg.speechRecognitionLanguage = lang;
    cfg.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,'Disabled');
    cfg.outputFormat = SpeechSDK.OutputFormat.Detailed;
    return new SpeechSDK.SpeechRecognizer(cfg, SpeechSDK.AudioConfig.fromDefaultMicrophoneInput());
  }
  function _listen(lang, onResult, onInterim) {
    const rec = _makeRec(lang);
    rec.recognizing = (_s,e) => { if(e.result.text) onInterim?.(e.result.text); };
    rec.recognized  = (_s,e) => { if(e.result.reason===SpeechSDK.ResultReason.RecognizedSpeech&&e.result.text){rec.stopContinuousRecognitionAsync();onResult(e.result.text);}};
    rec.canceled    = (_s,e) => { rec.stopContinuousRecognitionAsync(); onResult(null); };
    rec.startContinuousRecognitionAsync(()=>{}, err=>{console.error('[STT]',err);onResult(null);});
    return { stop: ()=>rec.stopContinuousRecognitionAsync() };
  }
  return {
    listenAR: (cb,interim) => _listen(AzureConfig.speech.sttLangAR, cb, interim),
    listenFR: (cb,interim) => _listen(AzureConfig.speech.sttLangFR, cb, interim),
  };
})();

/* ── GPT ── */
const GPT = (() => {
  async function call(messages, maxTokens=100) {
    const url = `${AzureConfig.openai.endpoint}openai/deployments/${AzureConfig.openai.deployment}/chat/completions?api-version=${AzureConfig.openai.apiVersion}`;
    const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','api-key':AzureConfig.openai.key},body:JSON.stringify({messages,max_tokens:maxTokens,temperature:0})});
    return (await r.json()).choices[0].message.content.trim();
  }

  async function intent(t) {
    try {
      const raw = await call([
        {role:'system',content:`مساعد إداري مغربي — حدد الخدمة
رجع JSON فقط: { "intent": "<key>", "confidence": <0-1> }
cin=كارط|كارط ناسيونال|لاكارط|CIN|CNIE|بطاقة وطنية
attestation=ورقة الدار|ورقة السكنى|شهادة السكنى|شهادة الإقامة
naissance=شهادة الازدياد|عقد الازدياد|ورقة الميلاد|نيجدي
revenu=ورقة الخدمة|ورقة الراتب|شهادة الدخل
nothing=والو|تا حاجة|ولا حاجة|ما محتاجش|شكرا|لا|باي|بسلامة
unknown=ما فهمتش`},
        {role:'user',content:t}
      ], 60);
      return JSON.parse(raw);
    } catch { return {intent:'unknown',confidence:0}; }
  }

  async function extract(t, key) {
    const rules = {
      cin_letters: `حروف البطاقة اللاتينية — 1 أو 2 حرف. رجع الحرف/الحرفين بالكبير فقط`,
      cin_numbers: `أرقام البطاقة — 5-7 أرقام. صفر|زيرو|سفر=0 واحد|وحدة=1 جوج|زوج=2 تلاتة=3 ربعة=4 خمسة=5 ستة=6 سبعة=7 تمنية=8 تسعود=9. رجع أرقام فقط`,
      tel: `رقم هاتف مغربي 10 أرقام (06/07/05). نفس قواعد الأرقام. رجع أرقام فقط`,
      salaire: `راتب شهري — رقم فقط. صفر=0 واحد=1 جوج=2 تلاتة=3 ربعة=4 خمسة=5 ستة=6 سبعة=7 تمنية=8 تسعود=9 ألف=1000 مية=100. مثال: خمسة آلاف=5000`,
      adr: `العنوان الكامل كما قاله`,
      ville: `اسم المدينة بالعربية`,
      lieu: `مدينة الازدياد بالعربية`,
      naissance: `تاريخ الميلاد DD/MM/YYYY`,
      motif: `سبب البطاقة — EXPIRATION أو PERTE أو DETERIORATION`,
      emploi: `اسم الشركة أو المؤسسة`,
    };
    try {
      const raw = await call([
        {role:'system',content:`استخرج من الدارجة المغربية. الحقل: ${rules[key]||key}
رجع JSON فقط: { "value": "<القيمة>", "confidence": <0-1> }
إلا ما فهمتيش: { "value": null, "confidence": 0 }`},
        {role:'user',content:t}
      ], 60);
      const p = JSON.parse(raw);
      console.log(`[GPT.extract] ${key}: "${t}" → "${p.value}" (${p.confidence})`);
      return p;
    } catch { return {value:null,confidence:0}; }
  }

  async function normaliseLastName(raw) {
    try {
      const r = await call([
        {role:'system',content:`حول اسم العائلة. رجع JSON: { "normalised": "<CAPS Latin>", "ar": "<بالعربية>", "question": "<تأكيد بالدارجة>" }
القاعدة: إذا جاء بحروف لاتينية حوله للعربية أولاً ثم رجع العربي في "ar"
أمثلة:
"الفاسي"→{"normalised":"AL FASSI","ar":"الفاسي","question":"واش اسم العائلة ديالك هو الفاسي"}
"بنعلي"→{"normalised":"BENALI","ar":"بنعلي","question":"واش اسم العائلة ديالك هو بنعلي"}
"الشرقاوي"→{"normalised":"CHERKAOUI","ar":"الشرقاوي","question":"واش اسم العائلة ديالك هو الشرقاوي"}`},
        {role:'user',content:raw}
      ], 80);
      return JSON.parse(r);
    } catch { return {normalised:raw.toUpperCase(),ar:raw,question:`واش اسم العائلة ديالك هو ${raw}`}; }
  }

  async function fuzzyFirstName(raw) {
    try {
      const r = await call([
        {role:'system',content:`ابحث عن أقرب اسم شخصي مغربي رسمي صوتياً
ذكور: محمد|أحمد|يوسف|عمر|علي|إبراهيم|عبد الله|حمزة|آدم|إسماعيل|خالد|سعيد|كريم|رشيد|مصطفى|المهدي|أنس|زكريا|ياسين|هشام|أيمن|طارق|نبيل|بلال|وليد|عبد الرحمان|عبد العزيز|سفيان|رضا|مراد|يحيى|عثمان|إدريس|عصام
إناث: فاطمة|مريم|خديجة|زينب|أسماء|هند|سلمى|نور|ريم|إيمان|حنان|سارة|لطيفة|أمينة|ليلى|وفاء|نادية|سناء|دنيا|حياة|رحمة|إكرام|سمية|كوثر|ملاك|نجوى|روان|شيماء
رجع JSON: { "suggested": "<CAPS Latin>", "ar": "<الاسم بالعربية دائماً>", "confidence": <0-1>, "question": "<تأكيد بالدارجة بالاسم العربي>" }
القاعدة المهمة: "ar" يجب أن يكون دائماً بالحروف العربية حتى لو الإدخال كان بالحروف اللاتينية
أمثلة:
"محمد"→{"suggested":"MOHAMMED","ar":"محمد","confidence":0.97,"question":"واش اسمك الشخصي هو محمد"}
"يسين"→{"suggested":"YASSINE","ar":"ياسين","confidence":0.92,"question":"واش اسمك الشخصي هو ياسين"}
"mohammed"→{"suggested":"MOHAMMED","ar":"محمد","confidence":0.95,"question":"واش اسمك الشخصي هو محمد"}
"fatima"→{"suggested":"FATIMA","ar":"فاطمة","confidence":0.95,"question":"واش اسمك الشخصي هو فاطمة"}
"مرييم"→{"suggested":"MARYAM","ar":"مريم","confidence":0.91,"question":"واش اسمك الشخصي هو مريم"}`},
        {role:'user',content:raw}
      ], 100);
      return JSON.parse(r);
    } catch { return {suggested:raw.toUpperCase(),ar:raw,confidence:0.5,question:`واش اسمك الشخصي هو ${raw}`}; }
  }

  async function fuzzyCity(raw) {
    try {
      const r = await call([
        {role:'system',content:`ابحث عن أقرب مدينة مغربية. رجع JSON: { "suggested": "<بالعربية>", "suggested_fr": "<FR>", "confidence": <0-1>, "question": "<تأكيد بالدارجة>" }
المدن: الدار البيضاء|الرباط|فاس|مراكش|أكادير|طنجة|مكناس|وجدة|القنيطرة|تطوان|سلا|خريبكة|بني ملال|الجديدة|برشيد|سطات|تازة|الناظور|آسفي|المحمدية|قلعة السراغنة|الرشيدية|ورزازات|إفران|العيون|الداخلة
"الكازا"→{"suggested":"الدار البيضاء","suggested_fr":"CASABLANCA","confidence":0.95,"question":"واش المدينة ديالك هي الدار البيضاء"}
"خريبكة"→{"suggested":"خريبكة","suggested_fr":"KHOURIBGA","confidence":0.99,"question":"واش المدينة ديالك هي خريبكة"}`},
        {role:'user',content:raw}
      ], 80);
      return JSON.parse(r);
    } catch { return {suggested:raw,suggested_fr:raw.toUpperCase(),confidence:0.5,question:`واش المدينة ديالك هي ${raw}`}; }
  }

  async function extractMotif(t) {
    try {
      const raw = await call([
        {role:'system',content:`حدد سبب البطاقة. رجع JSON: { "value": "<EXPIRATION|PERTE|DETERIORATION|AUTRE>", "label_ar": "<بالعربية>", "confidence": <0-1> }
EXPIRATION=منتهية|خلات|تقادمت|داز وقتها|ما خدامتش
PERTE=ضاعت|توضرات|تجلات|حلات|سرقت|ما لقيتهاش|فقدت
DETERIORATION=تلفت|تكسرات|تخربت|مش مقروءة`},
        {role:'user',content:t}
      ], 60);
      return JSON.parse(raw);
    } catch { return {value:'AUTRE',label_ar:'سبب آخر',confidence:0.5}; }
  }

  async function extractCINLetters(t) {
    try {
      const raw = await call([{role:'system',content:`استخرج 1-2 حرف لاتيني من البطاقة الوطنية. رجع بالكبير فقط أو null`},{role:'user',content:t}], 10);
      const c = raw.replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,2);
      return c || null;
    } catch { return null; }
  }

  async function yesNo(t) {
    if (!t) return 'unclear';
    try {
      const raw = await call([
        {role:'system',content:`نعم|آه|واخا|صحيح|أيه|هاه|أكيد|ايوه|واه|ايه|آآه|أآه|آهه|صح|إيه|ها|هاه = yes
لا|ماشي|غلط|لالا|خطأ|لأ = no
رجع JSON فقط: {"answer":"yes"|"no"|"unclear"}`},
        {role:'user',content:t}
      ], 15);
      return JSON.parse(raw).answer || 'unclear';
    } catch { return 'unclear'; }
  }

  async function detectChangeField(t) {
    try {
      const raw = await call([
        {role:'system',content:`هل المستخدم يريد تغيير إجابته؟
كلمات التغيير: بغيت نبدل|بغيت نبدلو|غلط|ماشي هادشي|عاود من البداية|مشي هو|خطأ|لا مزيان|بغيت نغير|نبغي نبدل|مشي هادا|لا هادشي غلط|صحح|بدل
رجع JSON: {"change":true} أو {"change":false}`},
        {role:'user',content:t}
      ], 15);
      return JSON.parse(raw).change === true;
    } catch { return false; }
  }

  async function detectSubmit(t) {
    try {
      const raw = await call([
        {role:'system',content:`هل المستخدم يريد إرسال الطلب؟
ارسل|أرسل|سيفط|سافط|إرسال|واصل|بعث|صيفط|سند|تأكيد|ابعث|اوافق|موافق|خلاص ارسل|نعم ارسل
رجع JSON: {"submit":true} أو {"submit":false}`},
        {role:'user',content:t}
      ], 15);
      return JSON.parse(raw).submit === true;
    } catch { return false; }
  }

  async function mergeCIN(letters, digits) {
    try {
      const raw = await call([
        {role:'system',content:`ادمج حروف وأرقام البطاقة. رجع النتيجة فقط مثلا AB123456`},
        {role:'user',content:`حروف: ${letters}\nأرقام: ${digits}`}
      ], 15);
      return raw.replace(/\s/g,'').toUpperCase();
    } catch { return (letters+digits).replace(/\s/g,'').toUpperCase(); }
  }

  return { intent, extract, normaliseLastName, fuzzyFirstName, fuzzyCity,
           extractMotif, extractCINLetters, yesNo, detectSubmit, detectChangeField, mergeCIN };
})();


/* ── SERVICE DEFINITIONS — all forms use separate NOM + PRÉNOM ── */
const SERVICES = {
  attestation: {
    title:'شهادة السكنى', badge:'Attestation de résidence',
    url:'portail.ma/commune/attestation-residence', greeting:'واخا سنعاونك فشهادة السكنى هيا نبداو',
    fields:[
      {key:'nom',   label:'NOM DE FAMILLE', ar:'اسم العائلة',  hint:'AL FASSI',   question:'شنو هو اسم عائلتك',                         isLastName:true},
      {key:'prenom',label:'PRÉNOM',          ar:'الاسم الشخصي', hint:'MOHAMMED',   question:'شنو هو اسمك الشخصي',                        isFirstName:true},
      {key:'cin_letters',label:'CIN — LETTRES', ar:'حروف البطاقة', hint:'AB',     question:'قول الحروف ديال البطاقة بالفرانساوي',        isCinLetters:true},
      {key:'cin_numbers',label:'CIN — CHIFFRES',ar:'أرقام البطاقة',hint:'123456', question:'دابا قول الأرقام ديال البطاقة',              isCinNumbers:true},
      {key:'adr',   label:'ADRESSE',          ar:'العنوان',       hint:'شارع الحسن الثاني', question:'شنو هو عنوانك الكامل'},
      {key:'ville', label:'VILLE',            ar:'المدينة',       hint:'خريبكة',   question:'فأي مدينة كاتسكن',                          isCity:true},
      {key:'tel',   label:'TÉLÉPHONE',        ar:'رقم الهاتف',    hint:'0612345678',question:'شنو هو رقم تيليفونك'},
    ]
  },
  naissance: {
    title:'شهادة الميلاد', badge:'Acte de naissance',
    url:'portail.ma/etat-civil/naissance', greeting:'واخا سنعاونك فشهادة الازدياد هيا نبداو',
    fields:[
      {key:'nom',   label:'NOM DE FAMILLE', ar:'اسم العائلة',  hint:'AL FASSI',   question:'شنو هو اسم عائلتك',                         isLastName:true},
      {key:'prenom',label:'PRÉNOM',          ar:'الاسم الشخصي', hint:'MOHAMMED',   question:'شنو هو اسمك الشخصي',                        isFirstName:true},
      {key:'cin_letters',label:'CIN — LETTRES', ar:'حروف البطاقة', hint:'AB',     question:'قول الحروف ديال البطاقة بالفرانساوي',        isCinLetters:true},
      {key:'cin_numbers',label:'CIN — CHIFFRES',ar:'أرقام البطاقة',hint:'123456', question:'دابا قول الأرقام ديال البطاقة',              isCinNumbers:true},
      {key:'naissance',label:'DATE NAISSANCE',ar:'تاريخ الميلاد',hint:'JJ/MM/AAAA',question:'فوقاش ولدتي عطيني تاريخ الميلاد ديالك'},
      {key:'lieu',  label:'LIEU NAISSANCE',  ar:'مكان الازدياد',hint:'خريبكة',   question:'فأي مدينة ولدتي',                            isCity:true},
      {key:'tel',   label:'TÉLÉPHONE',        ar:'رقم الهاتف',    hint:'0612345678',question:'شنو هو رقم تيليفونك'},
    ]
  },
  cin: {
    title:'البطاقة الوطنية', badge:'Renouvellement / Première demande CNIE',
    url:'www.cnie.ma/request-type', greeting:'واخا سنعاونك فالبطاقة الوطنية هيا نبداو',
    fields:[
      {key:'nom',   label:'NOM DE FAMILLE',  ar:'اسم العائلة',          hint:'AL FASSI',   question:'شنو هو اسم عائلتك',                          isLastName:true},
      {key:'prenom',label:'PRÉNOM',           ar:'الاسم الشخصي',         hint:'MOHAMMED',   question:'شنو هو اسمك الشخصي',                         isFirstName:true},
      {key:'cin_letters',label:'CIN — LETTRES', ar:'حروف البطاقة القديمة',hint:'AB',       question:'قول الحروف ديال البطاقة القديمة بالفرانساوي', isCinLetters:true},
      {key:'cin_numbers',label:'CIN — CHIFFRES',ar:'أرقام البطاقة القديمة',hint:'123456', question:'دابا قول الأرقام ديال البطاقة القديمة',        isCinNumbers:true},
      {key:'motif', label:'MOTIF',            ar:'سبب الطلب',            hint:'EXPIRATION', question:'علاش بغيتي تجدد البطاقة لأن منتهية ولا ضاعت ولا تلفت', isMotif:true},
      {key:'naissance',label:'DATE NAISSANCE',ar:'تاريخ الميلاد',        hint:'JJ/MM/AAAA', question:'فوقاش ولدتي عطيني تاريخ الميلاد ديالك'},
      {key:'ville', label:'VILLE',            ar:'المدينة',               hint:'خريبكة',   question:'فأي مدينة كاتسكن',                            isCity:true},
      {key:'tel',   label:'TÉLÉPHONE',        ar:'رقم الهاتف',            hint:'0612345678',question:'شنو هو رقم تيليفونك'},
    ]
  },
  revenu: {
    title:'شهادة الدخل', badge:'Attestation de revenu',
    url:'portail.ma/emploi/revenu', greeting:'واخا سنعاونك فشهادة الدخل هيا نبداو',
    fields:[
      {key:'nom',   label:'NOM DE FAMILLE', ar:'اسم العائلة',  hint:'AL FASSI',   question:'شنو هو اسم عائلتك',                         isLastName:true},
      {key:'prenom',label:'PRÉNOM',          ar:'الاسم الشخصي', hint:'MOHAMMED',   question:'شنو هو اسمك الشخصي',                        isFirstName:true},
      {key:'cin_letters',label:'CIN — LETTRES', ar:'حروف البطاقة', hint:'AB',     question:'قول الحروف ديال البطاقة بالفرانساوي',        isCinLetters:true},
      {key:'cin_numbers',label:'CIN — CHIFFRES',ar:'أرقام البطاقة',hint:'123456', question:'دابا قول الأرقام ديال البطاقة',              isCinNumbers:true},
      {key:'emploi',label:'EMPLOYEUR',       ar:'جهة العمل',     hint:'OCP خريبكة',question:'فأي شركة أو مؤسسة كاتخدم'},
      {key:'salaire',label:'SALAIRE (MAD)',  ar:'الراتب الشهري', hint:'5000',      question:'شحال هو الراتب الشهري ديالك'},
      {key:'tel',   label:'TÉLÉPHONE',        ar:'رقم الهاتف',    hint:'0612345678',question:'شنو هو رقم تيليفونك'},
    ]
  }
};

/* ── APP STATE ── */
const AppState = { phase:'idle', service:null, fieldIndex:0, currentField:null, answers:{}, pendingCinLetters:null, sttHandle:null, startTime:null };

/* ── FORM MANAGER ── */
const FormManager = {
  render(serviceKey) {
    const svc = SERVICES[serviceKey];
    const container = document.getElementById('form-fields-container');
    container.innerHTML = '';
    const btn = document.getElementById('form-submit-btn');
    if (btn) { btn.style.display='none'; btn.disabled=true; }

    let i = 0;
    while (i < svc.fields.length) {
      const field = svc.fields[i];
      if (field.isCinLetters && svc.fields[i+1]?.isCinNumbers) {
        const wrap = document.createElement('div'); wrap.className='cin-row'; wrap.id='field-group-cin-row';
        [svc.fields[i], svc.fields[i+1]].forEach(f => {
          const badge = f.isCinLetters ? '<span class="field-lang-badge fr">FR</span>' : '<span class="field-lang-badge ar">AR</span>';
          const part = document.createElement('div'); part.className='field-group cin-part'; part.id=`field-group-${f.key}`;
          part.innerHTML=`<div class="field-label-row"><span class="field-label">${f.label}</span>${badge}<span class="field-ar-label">${f.ar}</span></div><input type="text" id="field-${f.key}" name="${f.key}" class="field-input cin-part-input" placeholder="${f.hint}" autocomplete="off"/>`;
          wrap.appendChild(part);
        });
        const merged = document.createElement('div'); merged.id='field-group-cin-merged'; merged.className='field-group field-group-cin-merged'; merged.style.display='none';
        merged.innerHTML=`<div class="field-label-row"><span class="field-label">N° CIN COMPLET</span><span class="field-ar-label">رقم البطاقة الكامل</span></div><input type="text" id="field-cin" name="cin" class="field-input cin-merged-input" placeholder="AB123456" readonly/>`;
        wrap.appendChild(merged); container.appendChild(wrap); i+=2; continue;
      }
      if (field.isLastName || field.isFirstName) {
        const group = document.createElement('div'); group.className='field-group field-group-name'; group.id=`field-group-${field.key}`;
        group.innerHTML=`<div class="field-label-row"><span class="field-label">${field.label}</span><span class="field-ar-label">${field.ar}</span></div><div class="name-inputs-row"><div class="name-input-wrap"><span class="name-lang-tag">FR</span><input type="text" id="field-${field.key}" name="${field.key}" class="field-input name-input-fr" placeholder="${field.hint}" autocomplete="off"/></div><div class="name-input-wrap"><span class="name-lang-tag ar">AR</span><input type="text" id="field-${field.key}-ar" name="${field.key}_ar" class="field-input name-input-ar" placeholder="بالعربية" autocomplete="off" readonly/></div></div>`;
        container.appendChild(group); i++; continue;
      }
      const group = document.createElement('div'); group.className='field-group'; group.id=`field-group-${field.key}`;
      group.innerHTML=`<div class="field-label-row"><span class="field-label">${field.label}</span><span class="field-ar-label">${field.ar}</span></div><input type="text" id="field-${field.key}" name="${field.key}" class="field-input" placeholder="${field.hint}" autocomplete="off"/>`;
      container.appendChild(group); i++;
    }
    document.getElementById('form-title').textContent  = svc.title;
    document.getElementById('form-badge').textContent  = svc.badge;
    document.getElementById('browser-url').textContent = svc.url;
    this.updateProgress(serviceKey);
  },
  fillName(key, valueFR, valueAR) {
    const fr=document.getElementById(`field-${key}`); const ar=document.getElementById(`field-${key}-ar`);
    if(fr){fr.value=valueFR;fr.classList.add('filled');fr.classList.remove('active-field');}
    if(ar){ar.value=valueAR;ar.classList.add('filled');}
    fr?.scrollIntoView({behavior:'smooth',block:'center'});
  },
  fillField(key, value) {
    const el=document.getElementById(`field-${key}`); if(!el)return;
    el.value=value; el.classList.add('filled'); el.classList.remove('active-field');
    el.dispatchEvent(new Event('input',{bubbles:true})); el.scrollIntoView({behavior:'smooth',block:'center'});
  },
  setActive(key) {
    document.querySelectorAll('.field-input').forEach(e=>e.classList.remove('active-field'));
    const el=document.getElementById(`field-${key}`);
    if(el&&!el.classList.contains('filled')){el.classList.add('active-field');el.scrollIntoView({behavior:'smooth',block:'center'});}
  },
  filledCount(sk) { return SERVICES[sk].fields.filter(f=>{const el=document.getElementById(`field-${f.key}`);return el&&el.value.trim().length>0;}).length; },
  updateProgress(sk) {
    const total=SERVICES[sk].fields.length, filled=this.filledCount(sk), pct=total>0?Math.round((filled/total)*100):0;
    document.getElementById('form-progress-fill').style.width=pct+'%';
    document.getElementById('form-progress-label').textContent=`${filled} / ${total}`;
    const btn=document.getElementById('form-submit-btn'); if(!btn)return;
    if(filled>=total){btn.style.display='';btn.disabled=false;btn.scrollIntoView({behavior:'smooth',block:'nearest'});}
    else btn.disabled=true;
  },
  collect() { return new FormData(document.getElementById('admin-form')); }
};

/* ── VOICE FLOW ── */
const VoiceFlow = {
  async greet() {
    AppState.phase='greeting'; UI.setStatus('processing','مرحبا'); UI.setFooterStrip('','مرحبا بيك في يسّر');
    await TTSQueue.speak('مرحبا بيك شنو تبغي دير اليوم'); await this.listenForIntent();
  },
  async listenForIntent() {
    AppState.phase='listening-intent'; UI.showState('state-listening'); UI.setStatus('listening','كنسمع');
    UI.setMicState('listening'); UI.setFooterStrip('listening','كنسمعك تكلم دابا');
    const t = await this._listenAR(interim => {
      document.getElementById('live-transcript').innerHTML=interim+'<span class="transcript-cursor">|</span>';
    });
    if(!t){await TTSQueue.speak('ما سمعتكش عاود حاول');return this.listenForIntent();}
    document.getElementById('live-transcript').textContent=t;
    UI.showState('state-processing'); UI.setMicState('processing'); UI.setStatus('processing','كنفهم');
    const {intent,confidence} = await GPT.intent(t);
    if(intent==='nothing'){await TTSQueue.speak('واخا مشكلة ماكاينش يسّر في خدمتك');UI.setMicState('idle');UI.setStatus('ready','واخا');UI.setFooterStrip('','اضغط وتكلم');AppState.phase='idle';return;}
    if(!SERVICES[intent]||confidence<0.5){await TTSQueue.speak('ما فهمتكش قول ليا مثلا ورقة الدار ولا تجديد لاكارط');return this.listenForIntent();}
    await this.startService(intent);
  },
  async startService(key) {
    AppState.service=key; AppState.fieldIndex=0; AppState.answers={}; AppState.pendingCinLetters=null; AppState.startTime=Date.now();
    const svc=SERVICES[key]; FormManager.render(key); UI.showState('state-form');
    UI.setBrowserUrl(svc.url,true); UI.setHeaderContext(svc.title); UI.setStatus('processing',svc.title);
    await TTSQueue.speak(svc.greeting); await this.collectNext();
  },
  async collectNext() {
    const svc=SERVICES[AppState.service];
    if(AppState.fieldIndex>=svc.fields.length) return this.finishForm();
    const field=svc.fields[AppState.fieldIndex];
    AppState.currentField=field.key; AppState.phase='listening-field';
    UI.setVoiceQuestion(`${field.label} — ${field.ar}`, field.question);
    FormManager.setActive(field.key); UI.showTextFallback(true);
    document.getElementById('text-input').placeholder=field.hint;
    await TTSQueue.speak(field.question);
    UI.setStatus('listening',field.label); UI.setMicState('listening'); UI.setFooterStrip('listening',field.question);

    /* ── LAST NAME ── */
    if(field.isLastName) {
      const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
      if(!t){await TTSQueue.speak('ما سمعتكش عاود قول اسم العائلة');return this.collectNext();}
      UI.setMicState('processing');
      const raw=t.trim().replace(/[؟?!،,.:;]/g,'').trim();
      if(!raw){await TTSQueue.speak('ما فهمتش عاود قول اسم العائلة');return this.collectNext();}
      const {normalised,ar:arName,question:confirmQ}=await GPT.normaliseLastName(raw);
      AppState.phase='confirming-name'; UI.setVoiceQuestion(field.label,confirmQ); UI.setFooterStrip('listening',confirmQ);
      await TTSQueue.speak(confirmQ); UI.setMicState('listening');
      const conf=await this._listenWithTimeout(10000);
      const ans=await GPT.yesNo(conf||'');
      if(ans==='no'){await TTSQueue.speak('واخا عاود قول اسم العائلة بوضوح');AppState.phase='listening-field';return this.collectNext();}
      FormManager.fillName(field.key,normalised,arName||raw);
      AppState.answers[field.key]=normalised; FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success',`${field.label}: ${normalised}`); UI.setMicState('idle');
      await TTSQueue.speak('مزيان'); await delay(150); AppState.fieldIndex++; AppState.phase='listening-field'; return this.collectNext();
    }

    /* ── FIRST NAME ── */
    if(field.isFirstName) {
      const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
      if(!t){await TTSQueue.speak('ما سمعتكش عاود قول اسمك الشخصي');return this.collectNext();}
      UI.setMicState('processing');
      const raw=t.trim().replace(/[؟?!،,.:;]/g,'').trim();
      if(!raw){await TTSQueue.speak('ما فهمتش عاود قول اسمك الشخصي');return this.collectNext();}
      const {suggested,ar:arName,question:confirmQ}=await GPT.fuzzyFirstName(raw);
      AppState.phase='confirming-name'; UI.setVoiceQuestion(field.label,confirmQ); UI.setFooterStrip('listening',confirmQ);
      await TTSQueue.speak(confirmQ); UI.setMicState('listening');
      const conf=await this._listenWithTimeout(10000);
      const ans=await GPT.yesNo(conf||'');
      if(ans==='no'){await TTSQueue.speak('واخا عاود قول اسمك الشخصي بوضوح');AppState.phase='listening-field';return this.collectNext();}
      FormManager.fillName(field.key,suggested,arName||raw);
      AppState.answers[field.key]=suggested; FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success',`${field.label}: ${suggested}`); UI.setMicState('idle');
      await TTSQueue.speak('مزيان'); await delay(150); AppState.fieldIndex++; AppState.phase='listening-field'; return this.collectNext();
    }

    /* ── CIN LETTERS ── */
    if(field.isCinLetters) {
      const t=await this._listenFR(i=>UI.setFooterStrip('listening',i));
      if(!t){await TTSQueue.speak('ما سمعتكش عاود قول الحروف');return this.collectNext();}
      UI.setMicState('processing');
      const letters=await GPT.extractCINLetters(t);
      if(!letters){await TTSQueue.speak('ما فهمتش عاود قول الحروف بالفرانساوي');return this.collectNext();}
      AppState.pendingCinLetters=letters; FormManager.fillField('cin_letters',letters);
      await TTSQueue.speak('مزيان '+letters.split('').join(' ')); await delay(150); AppState.fieldIndex++; return this.collectNext();
    }

    /* ── CIN NUMBERS ── */
    if(field.isCinNumbers) {
      const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
      if(!t){await TTSQueue.speak('ما سمعتكش عاود قول الأرقام');return this.collectNext();}
      UI.setMicState('processing');
      const {value:digits}=await GPT.extract(t,'cin_numbers');
      if(!digits){await TTSQueue.speak('ما فهمتش عاود قول الأرقام');return this.collectNext();}
      const full=await GPT.mergeCIN(AppState.pendingCinLetters||'',digits);
      FormManager.fillField('cin_numbers',digits); FormManager.fillField('cin',full);
      AppState.answers['cin']=full; AppState.pendingCinLetters=null;
      const merged=document.getElementById('field-group-cin-merged'); if(merged)merged.style.display='';
      FormManager.updateProgress(AppState.service); UI.setFooterStrip('success','CIN: '+full); UI.setMicState('idle');
      await TTSQueue.speak('مزيان رقم البطاقة هو '+full.split('').join(' ')); await delay(150); AppState.fieldIndex++; return this.collectNext();
    }

    /* ── CITY ── */
    if(field.isCity) {
      const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
      if(!t){await TTSQueue.speak('ما سمعتكش عاود قول المدينة');return this.collectNext();}
      UI.setMicState('processing');
      const raw=t.trim().replace(/[؟?!،,.:;]/g,'').trim();
      const {suggested,suggested_fr,question:confirmQ}=await GPT.fuzzyCity(raw);
      AppState.phase='confirming-name'; UI.setVoiceQuestion(field.label,confirmQ); UI.setFooterStrip('listening',confirmQ);
      await TTSQueue.speak(confirmQ); UI.setMicState('listening');
      const conf=await this._listenWithTimeout(10000);
      const ans=await GPT.yesNo(conf||'');
      if(ans==='no'){await TTSQueue.speak('واخا عاود قول المدينة');AppState.phase='listening-field';return this.collectNext();}
      FormManager.fillField(field.key,suggested_fr); AppState.answers[field.key]=suggested_fr;
      const el=document.getElementById(`field-${field.key}`); if(el)el.setAttribute('data-ar',suggested);
      FormManager.updateProgress(AppState.service); UI.setFooterStrip('success',`${field.label}: ${suggested}`); UI.setMicState('idle');
      await TTSQueue.speak('مزيان '+suggested); await delay(150); AppState.fieldIndex++; AppState.phase='listening-field'; return this.collectNext();
    }

    /* ── MOTIF ── */
    if(field.isMotif) {
      const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
      if(!t){await TTSQueue.speak('ما سمعتكش عاود قول السبب');return this.collectNext();}
      UI.setMicState('processing');
      const {value,label_ar,confidence}=await GPT.extractMotif(t);
      if(!value||confidence<0.4){await TTSQueue.speak('ما فهمتش قول منتهية ولا ضاعت ولا تلفت');return this.collectNext();}
      FormManager.fillField(field.key,value); AppState.answers[field.key]=value;
      FormManager.updateProgress(AppState.service); UI.setFooterStrip('success',`${field.label}: ${label_ar}`); UI.setMicState('idle');
      await TTSQueue.speak('مزيان '+label_ar); await delay(150); AppState.fieldIndex++; AppState.phase='listening-field'; return this.collectNext();
    }

    /* ── STANDARD ── */
    const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
    if(!t){await TTSQueue.speak('ما سمعتكش عاود جاوب');return this.collectNext();}
    UI.setMicState('processing'); UI.setStatus('processing','كنفهم');

    // Check change-field intent
    const wantsChange=await GPT.detectChangeField(t);
    if(wantsChange&&AppState.fieldIndex>0){await TTSQueue.speak('واخا سنرجع للحقل اللي فات');return this._handleFieldChange();}

    const {value,confidence}=await GPT.extract(t,field.key);
    if(!value||confidence<0.35){await TTSQueue.speak('ما فهمتش مزيان عاود قول');return this.collectNext();}
    FormManager.fillField(field.key,value); AppState.answers[field.key]=value;
    FormManager.updateProgress(AppState.service); UI.setFooterStrip('success',`${field.label}: ${value}`);
    UI.setMicState('idle'); UI.setStatus('ready','مزيان');
    await TTSQueue.speak('مزيان '+value); await delay(150); AppState.fieldIndex++; AppState.phase='listening-field'; return this.collectNext();
  },

  async _handleFieldChange() {
    if(AppState.fieldIndex>0) {
      AppState.fieldIndex--;
      const field=SERVICES[AppState.service].fields[AppState.fieldIndex];
      const el=document.getElementById(`field-${field.key}`); if(el){el.value='';el.classList.remove('filled');}
      const arEl=document.getElementById(`field-${field.key}-ar`); if(arEl){arEl.value='';arEl.classList.remove('filled');}
      // Also clear CIN merged if going back to CIN area
      if(field.isCinLetters||field.isCinNumbers){
        const merged=document.getElementById('field-group-cin-merged'); if(merged)merged.style.display='none';
      }
      FormManager.updateProgress(AppState.service);
    }
    return this.collectNext();
  },

  async finishForm() {
    AppState.phase='done'; UI.setStatus('ready','واخا'); UI.showTextFallback(false);
    UI.setFooterStrip('success','تم جمع كل المعلومات'); UI.setMicState('idle');
    UI.setVoiceQuestion('','قول ارسل أو اضغط الزر');
    document.getElementById('form-submit-btn')?.scrollIntoView({behavior:'smooth'});
    await TTSQueue.speak('مزيان تم جمع كل المعلومات قول ارسل أو اضغط على زر الإرسال');
    await this.listenForSubmit();
  },

  async listenForSubmit() {
    AppState.phase='listening-submit'; UI.setMicState('listening'); UI.setFooterStrip('listening','قول ارسل أو سيفط');
    const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
    if(!t){UI.setMicState('idle');return;}
    // Check change intent at submit stage too
    const wantsChange=await GPT.detectChangeField(t);
    if(wantsChange){await TTSQueue.speak('واخا سنرجع للحقل اللي فات');return this._handleFieldChange();}
    const ok=await GPT.detectSubmit(t);
    UI.setMicState('idle');
    if(ok) document.getElementById('admin-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    else UI.setFooterStrip('success','اضغط زر الإرسال متى كنت مستعد');
  },

  async askAnythingElse() {
    AppState.phase='asking-more'; UI.setMicState('listening'); UI.setFooterStrip('listening','واش كاين شي حاجة أخرى');
    await TTSQueue.speak('واش كاين شي حاجة أخرى نعاونك فيها'); UI.setMicState('listening');
    const t=await this._listenAR(i=>UI.setFooterStrip('listening',i));
    const ans=await GPT.yesNo(t||'');
    if(ans==='yes'){await TTSQueue.speak('واخا قول ليا شنو تبغي');resetApp();await VoiceFlow.listenForIntent();}
    else{await TTSQueue.speak('مرحبا بيك مرة أخرى! ونهارك مبروك!');UI.setMicState('idle');UI.setStatus('ready','واخا');UI.setFooterStrip('','اضغط وتكلم');AppState.phase='idle';}
  },

  _listenAR(onInterim) { return new Promise(resolve=>{AppState.sttHandle=AzureSTT.listenAR(resolve,onInterim);}); },
  _listenFR(onInterim) { return new Promise(resolve=>{AppState.sttHandle=AzureSTT.listenFR(resolve,onInterim);}); },

  /* Listen with timeout — silence for `ms` ms → auto-resolve (treated as yes by caller) */
  _listenWithTimeout(ms) {
    return new Promise(resolve => {
      let _result=null, _timer=null, _rec=null;
      const done=(val)=>{ clearTimeout(_timer); if(_rec?.stop)_rec.stop(); resolve(val??_result); };
      _timer=setTimeout(()=>done(null), ms);
      _rec=AzureSTT.listenAR((text)=>{ _result=text; done(text); }, (interim)=>{ _result=interim; clearTimeout(_timer); _timer=setTimeout(()=>done(null),ms); });
      AppState.sttHandle=_rec;
    });
  },

  stopListening() { if(AppState.sttHandle?.stop){AppState.sttHandle.stop();AppState.sttHandle=null;} }
};

/* ── UI ── */
const UI = {
  showState(id) { document.querySelectorAll('.main-state').forEach(s=>s.classList.remove('active')); document.getElementById(id)?.classList.add('active'); },
  setStatus(type,label) { document.getElementById('status-dot').className='status-dot '+(type==='ready'?'':type); document.getElementById('status-label').textContent=label; },
  setMicState(state) {
    const btn=document.getElementById('mic-btn'), dflt=document.getElementById('mic-icon-default'), stop=document.getElementById('mic-icon-stop'), lbl=document.getElementById('mic-label'), bars=document.querySelectorAll('.fw-bar');
    btn.className='mic-btn';
    if(state==='listening'){btn.classList.add('listening');dflt.style.display='none';stop.style.display='block';lbl.textContent='اضغط باش توقف';lbl.style.color='#ef4444';bars.forEach(b=>b.classList.add('active'));}
    else if(state==='processing'){btn.classList.add('processing');dflt.style.display='block';stop.style.display='none';lbl.textContent='كنفهم';lbl.style.color='#b45309';bars.forEach(b=>b.classList.remove('active'));}
    else{dflt.style.display='block';stop.style.display='none';lbl.textContent='اضغط وتكلم';lbl.style.color='';bars.forEach(b=>b.classList.remove('active'));}
  },
  setFooterStrip(type,text) { document.getElementById('footer-strip').className='footer-strip '+(type||''); document.getElementById('footer-strip-text').textContent=text; },
  setBrowserUrl(url,loading=false) {
    const el=document.getElementById('browser-url'),ld=document.getElementById('browser-loader');
    el.textContent=url; el.classList.toggle('loaded',!loading); ld.classList.toggle('loading',loading);
    if(loading)setTimeout(()=>{ld.classList.remove('loading');el.classList.add('loaded');},1200);
  },
  setHeaderContext(text) { const el=document.getElementById('header-context'); el.textContent=text; el.classList.add('active-context'); },
  setVoiceQuestion(label,q) { document.getElementById('vq-field-label').textContent=label; document.getElementById('vq-question').textContent=q; },
  showTextFallback(show) { document.getElementById('text-fallback').style.display=show?'flex':'none'; if(show)setTimeout(()=>document.getElementById('text-input').focus(),100); },
  toast(msg,duration=2500) { const t=document.getElementById('toast'); t.textContent=msg; t.style.display='block'; clearTimeout(t._timer); t._timer=setTimeout(()=>t.style.display='none',duration); },
  showSuccessSplash(refNumber,savedMin) {
    let splash=document.getElementById('state-success');
    if(!splash){splash=document.createElement('div');splash.id='state-success';splash.className='main-state';document.querySelector('.main-content')?.appendChild(splash);}
    splash.innerHTML=`<div class="success-splash"><div class="success-checkmark"><svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="46" stroke="white" stroke-width="4" fill="none" opacity="0.3"/><path class="check-path" d="M25 52 L42 69 L75 33" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div><h2 class="success-title">تم الإرسال بنجاح</h2><p class="success-subtitle">طلبك وصل وغادي تتواصل معاك</p><div class="success-ref">${refNumber}</div><div class="success-time">${savedMin}</div><button class="success-new-btn" onclick="VoiceFlow.askAnythingElse()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>طلب جديد</button></div>`;
    this.showState('state-success');
  }
};

/* ── EVENT HANDLERS ── */
function handleMicPress() {
  AudioRouter.unlock(); // forces loudspeaker mode on mobile
  const ph=AppState.phase;
  if(['listening-intent','listening-field','confirming-name','listening-submit','asking-more'].includes(ph)){
    VoiceFlow.stopListening(); TTSQueue.cancel(); UI.setMicState('idle'); UI.setFooterStrip('','اضغط وتكلم'); AppState.phase='idle'; return;
  }
  if(ph==='idle'||ph==='done') VoiceFlow.greet();
}

function selectService(key) { AudioRouter.unlock(); VoiceFlow.stopListening(); TTSQueue.cancel(); VoiceFlow.startService(key); }

function submitTextInput() {
  const input=document.getElementById('text-input'), val=input.value.trim(); if(!val)return;
  const ph=AppState.phase;
  if(ph==='listening-intent'||ph==='idle'){
    VoiceFlow.stopListening(); UI.showState('state-processing'); UI.setMicState('processing');
    GPT.intent(val).then(({intent,confidence})=>{
      if(intent==='nothing'){TTSQueue.speak('واخا مشكلة ماكاينش');UI.setMicState('idle');AppState.phase='idle';}
      else if(SERVICES[intent]&&confidence>=0.5) VoiceFlow.startService(intent);
      else{UI.toast('ما فهمتكش عاود حاول');UI.showState('state-idle');UI.setMicState('idle');}
    });
  } else if(ph==='listening-field'){
    VoiceFlow.stopListening();
    const field=SERVICES[AppState.service]?.fields[AppState.fieldIndex]; if(!field)return;
    GPT.extract(val,field.key).then(({value,confidence})=>{
      if(!value||confidence<0.35){UI.toast('ما فهمتش عاود');return;}
      FormManager.fillField(field.key,value); AppState.answers[field.key]=value;
      FormManager.updateProgress(AppState.service); AppState.fieldIndex++; input.value='';
      setTimeout(()=>VoiceFlow.collectNext(),200);
    });
  } else if(ph==='done'||ph==='listening-submit'){
    GPT.detectSubmit(val).then(yes=>{if(yes)document.getElementById('admin-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  }
  input.value='';
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const fd=FormManager.collect(), payload={};
  for(const[k,v] of fd.entries()) payload[k]=v;
  console.log('[Yassir] Submit:',payload);
  const btn=document.getElementById('form-submit-btn');
  if(btn){btn.innerHTML=`<div style="width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;"></div><span>كنرسل</span>`;btn.style.gap='10px';btn.disabled=true;}
  await delay(1600);
  const elapsed=AppState.startTime?Math.round((Date.now()-AppState.startTime)/1000):0;
  const saved=Math.max(15-Math.round(elapsed/60),2);
  const ref='YSR-2026-'+(4800+Math.floor(Math.random()*200));
  const scNum=document.getElementById('sc-number'); if(scNum)scNum.textContent=ref;
  const stTime=document.getElementById('st-time'); if(stTime)stTime.textContent='وفرتي '+saved+' دقيقة';
  UI.showSuccessSplash(ref,'وفرتي '+saved+' دقيقة');
  UI.setStatus('ready','تم'); UI.setFooterStrip('success','تم إرسال الطلب بنجاح');
  await TTSQueue.speak('مزيان تم إرسال طلبك غادي يوصلك رقم المتابعة');
  await delay(800); await VoiceFlow.askAnythingElse();
}

function resetApp() {
  VoiceFlow.stopListening(); TTSQueue.cancel();
  Object.assign(AppState,{phase:'idle',service:null,fieldIndex:0,answers:{},currentField:null,pendingCinLetters:null,startTime:null});
  UI.showState('state-idle'); UI.setMicState('idle'); UI.setStatus('ready','واخا'); UI.setFooterStrip('','اضغط وتكلم'); UI.showTextFallback(false);
  const ctx=document.getElementById('header-context'); ctx.textContent='مساعدك الإداري الذكي'; ctx.classList.remove('active-context');
  const btn=document.getElementById('form-submit-btn');
  if(btn){btn.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>إرسال الطلب`;btn.disabled=true;btn.style.gap='';btn.style.display='none';}
}

function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

document.addEventListener('DOMContentLoaded',()=>{
  AudioRouter.init();
  const btn=document.getElementById('form-submit-btn'); if(btn)btn.style.display='none';
  setTimeout(()=>VoiceFlow.greet(),800);
});
