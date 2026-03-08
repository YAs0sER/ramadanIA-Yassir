/* ══════════════════════════════════════════════════
   YASSIR — يسّر  |  app.js  v5
   ══════════════════════════════════════════════════
   FIXES v5:
   1. NOM COMPLET in attestation/naissance/revenu:
      asks full name (first + last) once, fills both inputs
   2. Numbers fuzzy: صفر/زيرو/سفر/سافرت → 0, etc.
   3. Submit button: hidden until form 100% filled
      → no accidental trigger on load
   4. Success screen: full-screen light-green splash + huge ✓
   5. Audio overlap root fix: after saving a field,
      we await TTSQueue fully before _starting_ next
      collectNext() — no interleaved speaks
   6. والو/تا حاجة at intent screen → polite goodbye, stay idle
   7. After submit: ask if user needs anything else
      آه/واه/ايه → go back to start | لا/والو → goodbye idle
   ══════════════════════════════════════════════════ */

'use strict';

/* ══════════════════════════════════════════════════
   1. CONFIG
   ══════════════════════════════════════════════════ */
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


/* ══════════════════════════════════════════════════
   2. TTS QUEUE
   • Only ONE synthesizer alive at a time (_active)
   • cancel() kills it immediately + resets chain
   • speak() returns a Promise that resolves ONLY when
     audio finishes → callers can safely await it
   ══════════════════════════════════════════════════ */
const TTSQueue = (() => {
  let _chain  = Promise.resolve();
  let _active = null;
  let _skip   = false;

  function speak(text) {
    _chain = _chain.then(() => _skip ? Promise.resolve() : _synth(text));
    return _chain;          // caller awaits this → guaranteed serial
  }

  function cancel() {
    _skip = true;
    if (_active) { try { _active.close(); } catch(_){} _active = null; }
    _chain = Promise.resolve();
    setTimeout(() => { _skip = false; }, 80);
  }

  function _clean(t) {
    return t.replace(/[؟?!،,\.。:;«»""''()\[\]{}\-_\/\\|@#$%^&*+=<>~`]/g, ' ')
            .replace(/\s{2,}/g,' ').trim();
  }

  function _synth(text) {
    const clean = _clean(text);
    if (!clean) return Promise.resolve();

    const cfg = SpeechSDK.SpeechConfig.fromSubscription(
      AzureConfig.speech.key, AzureConfig.speech.region);
    cfg.speechSynthesisVoiceName = AzureConfig.speech.ttsVoice;

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-MA">
  <voice name="${AzureConfig.speech.ttsVoice}">
    <prosody rate="0.92" pitch="0%">${clean}</prosody>
  </voice>
</speak>`;

    const s = new SpeechSDK.SpeechSynthesizer(cfg);
    _active = s;
    return new Promise(resolve => {
      s.speakSsmlAsync(ssml,
        () => { _active = null; s.close(); resolve(); },
        () => { _active = null; s.close(); resolve(); }
      );
    });
  }

  return { speak, cancel };
})();


/* ══════════════════════════════════════════════════
   3. STT
   ══════════════════════════════════════════════════ */
const AzureSTT = (() => {
  function _makeRec(lang) {
    const cfg = SpeechSDK.SpeechConfig.fromSubscription(
      AzureConfig.speech.key, AzureConfig.speech.region);
    cfg.speechRecognitionLanguage = lang;
    cfg.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,'Disabled');
    cfg.outputFormat = SpeechSDK.OutputFormat.Detailed;
    return new SpeechSDK.SpeechRecognizer(
      cfg, SpeechSDK.AudioConfig.fromDefaultMicrophoneInput());
  }

  function _listen(lang, onResult, onInterim) {
    const rec = _makeRec(lang);
    rec.recognizing = (_s,e) => { if(e.result.text) onInterim?.(e.result.text); };
    rec.recognized  = (_s,e) => {
      if(e.result.reason===SpeechSDK.ResultReason.RecognizedSpeech && e.result.text){
        rec.stopContinuousRecognitionAsync();
        onResult(e.result.text);
      }
    };
    rec.canceled = (_s,e) => {
      console.warn('[STT] canceled',e.errorDetails);
      rec.stopContinuousRecognitionAsync();
      onResult(null);
    };
    rec.startContinuousRecognitionAsync(
      ()=>console.log('[STT] started',lang),
      err=>{ console.error('[STT]',err); onResult(null); }
    );
    return { stop: ()=>rec.stopContinuousRecognitionAsync() };
  }

  return {
    listenAR: (cb,interim) => _listen(AzureConfig.speech.sttLangAR, cb, interim),
    listenFR: (cb,interim) => _listen(AzureConfig.speech.sttLangFR, cb, interim),
  };
})();


/* ══════════════════════════════════════════════════
   4. GPT
   ══════════════════════════════════════════════════ */
const GPT = (() => {

  async function call(messages, maxTokens=100) {
    const url = `${AzureConfig.openai.endpoint}openai/deployments/${AzureConfig.openai.deployment}/chat/completions?api-version=${AzureConfig.openai.apiVersion}`;
    const r = await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json','api-key':AzureConfig.openai.key},
      body: JSON.stringify({messages, max_tokens:maxTokens, temperature:0})
    });
    return (await r.json()).choices[0].message.content.trim();
  }

  /* ── intent + والو/تا حاجة detection ── */
  async function intent(t) {
    try {
      const raw = await call([
        { role:'system', content:`مساعد إداري مغربي — حدد الخدمة أو إذا المستخدم قال ما يريد شيء
رجع JSON فقط: { "intent": "<key>", "confidence": <0-1> }

cin         = كارط|كارط ناسيونال|لاكارط|la carte|CIN|CNIE|CNI|بطاقة وطنية|البطاقة
attestation = ورقة الدار|ورقة السكنى|شهادة السكنى|شهادة الإقامة|ورقة ديال الدار
naissance   = شهادة الازدياد|عقد الازدياد|ورقة الميلاد|ورقة الولادة|نيجدي
revenu      = ورقة الخدمة|ورقة الراتب|شهادة الدخل|ورقة الأجر|شهادة العمل
nothing     = والو|تا حاجة|ولا حاجة|ما محتاجش|مزيان|شكرا|لا|ماشي|باي|بسلامة|ma besoin
unknown     = ما فهمتش` },
        { role:'user', content:t }
      ], 60);
      return JSON.parse(raw);
    } catch { return {intent:'unknown', confidence:0}; }
  }

  /* ── generic field extract ── */
  async function extract(t, key) {
    const rules = {
      cin_letters: `حروف البطاقة اللاتينية فقط — 1 أو 2 حرف مثلا A أو AB
المستخدم قد يقول حرف واحد كـ A أو alpha أو أ — هذا صحيح
رجع الحرف/الحرفين بالكبير فقط`,
      cin_numbers: `أرقام البطاقة فقط — 5 إلى 7 أرقام
المستخدم يتكلم بالدارجة أو العربية
مهم جداً: صفر|زيرو|زيرو|سفر|سافرت|صفار = 0
واحد=1 جوج=2 تلاتة=3 ربعة=4 خمسة=5 ستة=6 سبعة=7 تمنية=8 تسعود=9
رجع الأرقام فقط بلا حروف`,
      tel: `رقم الهاتف المغربي — 10 أرقام يبدأ ب 06 أو 07 أو 05
نفس قواعد الأرقام: صفر=0 واحد=1 جوج=2 تلاتة=3...
رجع الأرقام فقط`,
      salaire: `الراتب الشهري — رقم فقط بلا عملة
صفر=0 واحد=1 جوج=2 تلاتة=3 ربعة=4 خمسة=5 ستة=6 سبعة=7 تمنية=8 تسعود=9
ألف=1000 مية=100`,
      adr:       `العنوان الكامل كما قاله`,
      ville:     `اسم المدينة بالعربية كما قاله — لا تغيره`,
      lieu:      `مدينة الازدياد بالعربية كما قالها`,
      naissance: `تاريخ الميلاد بصيغة DD/MM/YYYY`,
      motif:     `سبب البطاقة — EXPIRATION أو PERTE أو DETERIORATION`,
      emploi:    `اسم الشركة أو المؤسسة`,
    };
    const rule = rules[key] || key;
    try {
      const raw = await call([
        { role:'system', content:`استخرج قيمة الحقل من الدارجة المغربية
الحقل: ${rule}
رجع JSON فقط: { "value": "<القيمة>", "confidence": <0-1> }
إلا ما فهمتيش: { "value": null, "confidence": 0 }
إذا سمعت أي قيمة معقولة رجع confidence 0.7 على الأقل` },
        { role:'user', content:t }
      ], 60);
      const p = JSON.parse(raw);
      console.log(`[GPT.extract] ${key}: "${t}" → "${p.value}" (${p.confidence})`);
      return p;
    } catch { return {value:null, confidence:0}; }
  }

  /* ── full name (NOM COMPLET): extract first + last ── */
  async function extractFullName(t) {
    try {
      const raw = await call([
        { role:'system', content:`المستخدم قال اسمه الكامل بالدارجة المغربية
استخرج اسم العائلة (NOM) والاسم الشخصي (PRÉNOM)
لا تغير أي اسم — فقط صحح الكتابة للحروف اللاتينية الكبيرة
رجع JSON فقط:
{ "nom": "<NOM DE FAMILLE EN CAPS>", "prenom": "<PRÉNOM EN CAPS>",
  "nom_ar": "<اسم العائلة بالعربية>", "prenom_ar": "<الاسم الشخصي بالعربية>",
  "question": "<تأكيد بالدارجة>", "confidence": <0-1> }
أمثلة:
"محمد الفاسي"→{"nom":"AL FASSI","prenom":"MOHAMMED","nom_ar":"الفاسي","prenom_ar":"محمد","question":"واش اسمك هو محمد الفاسي","confidence":0.96}
"فاطمة بنعلي"→{"nom":"BENALI","prenom":"FATIMA","nom_ar":"بنعلي","prenom_ar":"فاطمة","question":"واش اسمك هو فاطمة بنعلي","confidence":0.96}
إذا قال اسم واحد فقط استعمله كاسم العائلة واترك الاسم الشخصي فارغاً` },
        { role:'user', content:t }
      ], 120);
      return JSON.parse(raw);
    } catch { return null; }
  }

  /* ── last name only: normalise, don't change ── */
  async function normaliseLastName(raw) {
    try {
      const r = await call([
        { role:'system', content:`حول اسم العائلة للحروف اللاتينية الرسمية — لا تغيره أبدا
رجع JSON فقط: { "normalised": "<CAPS>", "question": "<تأكيد بالدارجة>" }
أمثلة:
"الفاسي"→{"normalised":"AL FASSI","question":"واش اسم العائلة ديالك هو الفاسي"}
"بنعلي"→{"normalised":"BENALI","question":"واش اسم العائلة ديالك هو بنعلي"}
"الشرقاوي"→{"normalised":"CHERKAOUI","question":"واش اسم العائلة ديالك هو الشرقاوي"}
"أيت باها"→{"normalised":"AIT BAHA","question":"واش اسم العائلة ديالك هو أيت باها"}` },
        { role:'user', content:raw }
      ], 80);
      return JSON.parse(r);
    } catch { return {normalised:raw.toUpperCase(), question:`واش اسم العائلة ديالك هو ${raw}`}; }
  }

  /* ── first name: fuzzy match to closest Moroccan name ── */
  async function fuzzyFirstName(raw) {
    try {
      const r = await call([
        { role:'system', content:`ابحث عن أقرب اسم شخصي مغربي رسمي لما سمعته
اختر الأقرب صوتياً من: محمد|أحمد|يوسف|عمر|علي|إبراهيم|عبد الله|حمزة|آدم|إسماعيل|خالد|سعيد|كريم|رشيد|مصطفى|المهدي|أنس|زكريا|ياسين|هشام|أيمن|طارق|نبيل|بلال|وليد|عبد الرحمان|عبد العزيز|عبد القادر
فاطمة|مريم|خديجة|زينب|أسماء|هند|سلمى|نور|ريم|إيمان|حنان|سارة|لطيفة|أمينة|ليلى|وفاء|نادية|سناء|دنيا|حياة|رحمة|إكرام
حول للحروف اللاتينية الكبيرة بالتهجئة المغربية
رجع JSON فقط: { "suggested": "<CAPS>", "confidence": <0-1>, "question": "<تأكيد بالدارجة>" }
أمثلة:
"محمد"→{"suggested":"MOHAMMED","confidence":0.97,"question":"واش اسمك الشخصي هو محمد"}
"مرييم"→{"suggested":"MARYAM","confidence":0.91,"question":"واش اسمك الشخصي هو مريم"}
"يسين"→{"suggested":"YASSINE","confidence":0.92,"question":"واش اسمك الشخصي هو ياسين"}` },
        { role:'user', content:raw }
      ], 80);
      return JSON.parse(r);
    } catch { return {suggested:raw.toUpperCase(), confidence:0.5, question:`واش اسمك الشخصي هو ${raw}`}; }
  }

  /* ── city fuzzy ── */
  async function fuzzyCity(raw) {
    try {
      const r = await call([
        { role:'system', content:`ابحث عن أقرب مدينة مغربية رسمية لما سمعته
المدن: الدار البيضاء|الرباط|فاس|مراكش|أكادير|طنجة|مكناس|وجدة|القنيطرة|تطوان|سلا|خريبكة|بني ملال|الجديدة|برشيد|سطات|تازة|الناظور|آسفي|المحمدية|قلعة السراغنة|الفقيه بن صالح|سيدي قاسم|بنسليمان|الرشيدية|ورزازات|إفران|العيون|الداخلة
رجع JSON فقط: { "suggested": "<بالعربية>", "suggested_fr": "<OFFICIEL FR>", "confidence": <0-1>, "question": "<تأكيد بالدارجة>" }
أمثلة:
"خريبكة"→{"suggested":"خريبكة","suggested_fr":"KHOURIBGA","confidence":0.99,"question":"واش المدينة ديالك هي خريبكة"}
"الكازا"→{"suggested":"الدار البيضاء","suggested_fr":"CASABLANCA","confidence":0.95,"question":"واش المدينة ديالك هي الدار البيضاء"}
"ربيبات"→{"suggested":"الرباط","suggested_fr":"RABAT","confidence":0.90,"question":"واش المدينة ديالك هي الرباط"}` },
        { role:'user', content:raw }
      ], 80);
      return JSON.parse(r);
    } catch { return {suggested:raw, suggested_fr:raw.toUpperCase(), confidence:0.5, question:`واش المدينة ديالك هي ${raw}`}; }
  }

  /* ── motif ── */
  async function extractMotif(t) {
    try {
      const raw = await call([
        { role:'system', content:`حدد سبب طلب البطاقة من الدارجة
EXPIRATION = منتهية|خلات|تقادمت|داز وقتها|صلحيتها خلات|ما خدامتش
PERTE      = ضاعت|توضرات|تجلات|حلات|سرقت|ما لقيتهاش|فقدت|نسيتها
DETERIORATION = تلفت|تكسرات|تخربت|مش مقروءة|تحترقت|تبلعت
رجع JSON فقط: { "value": "<EXPIRATION|PERTE|DETERIORATION|AUTRE>", "label_ar": "<بالعربية>", "confidence": <0-1> }
"ضاعت"→{"value":"PERTE","label_ar":"ضياع البطاقة","confidence":0.97}
"توضرات"→{"value":"PERTE","label_ar":"ضياع البطاقة","confidence":0.95}
"تجلات"→{"value":"PERTE","label_ar":"ضياع البطاقة","confidence":0.94}
"منتهية"→{"value":"EXPIRATION","label_ar":"انتهاء الصلاحية","confidence":0.97}
"تلفت"→{"value":"DETERIORATION","label_ar":"تلف البطاقة","confidence":0.96}` },
        { role:'user', content:t }
      ], 60);
      return JSON.parse(raw);
    } catch { return {value:'AUTRE', label_ar:'سبب آخر', confidence:0.5}; }
  }

  /* ── CIN letters (1 or 2) ── */
  async function extractCINLetters(t) {
    try {
      const raw = await call([
        { role:'system', content:`استخرج حرف أو حرفين لاتينيين من البطاقة الوطنية المغربية
المستخدم قد يقول حرف واحد "A" أو "alpha" أو "أ" — هذا صحيح ومقبول
رجع الحرف/الحرفين بالكبير فقط — مثلا: A أو AB
إلا ما فهمتيش رجع null` },
        { role:'user', content:t }
      ], 10);
      const c = raw.replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,2);
      console.log(`[GPT.cinLetters] "${t}"→"${c}"`);
      return c || null;
    } catch { return null; }
  }

  /* ── yes/no ── */
  async function yesNo(t) {
    if (!t) return 'unclear';
    try {
      const raw = await call([
        { role:'system', content:`نعم/آه/واخا/صحيح/أيه/هاه/أكيد/ايوه/واه/ايه = yes
لا/ماشي/غلط/لا ماشي/لالا/خطأ/لأ = no
رجع JSON فقط: {"answer":"yes"|"no"|"unclear"}` },
        { role:'user', content:t }
      ], 15);
      return JSON.parse(raw).answer || 'unclear';
    } catch { return 'unclear'; }
  }

  /* ── detect submit command ── */
  async function detectSubmit(t) {
    try {
      const raw = await call([
        { role:'system', content:`هل المستخدم يريد إرسال الطلب؟
كلمات الإرسال: ارسل|أرسل|سيفط|سافط|إرسال|واصل|بعث|صيفط|سند|تأكيد|ابعث|اوافق|موافق|خلاص ارسل|نعم ارسل
رجع JSON فقط: {"submit":true} أو {"submit":false}` },
        { role:'user', content:t }
      ], 15);
      return JSON.parse(raw).submit === true;
    } catch { return false; }
  }

  /* ── merge CIN ── */
  async function mergeCIN(letters, digits) {
    try {
      const raw = await call([
        { role:'system', content:`ادمج حروف وأرقام البطاقة الوطنية في نتيجة واحدة
الحروف: 1 أو 2 حرف لاتيني كبير — الأرقام: 5-7 أرقام
رجع النتيجة فقط — مثلا: AB123456 أو A654321` },
        { role:'user', content:`حروف: ${letters}\nأرقام: ${digits}` }
      ], 15);
      return raw.replace(/\s/g,'').toUpperCase();
    } catch { return (letters+digits).replace(/\s/g,'').toUpperCase(); }
  }

  return { intent, extract, extractFullName, normaliseLastName, fuzzyFirstName,
           fuzzyCity, extractMotif, extractCINLetters, yesNo, detectSubmit, mergeCIN };
})();


/* ══════════════════════════════════════════════════
   5. SERVICE DEFINITIONS
   ──────────────────────────────────────────────────
   isFullName  → ask full name once, fills nom + nom_ar
   isLastName  → family name only, normalise + verify
   isFirstName → first name, fuzzy + confirm
   isCity      → fuzzy city match
   isMotif     → rich Darija aliases
   isCinLetters / isCinNumbers → dual CIN flow
   ══════════════════════════════════════════════════ */
const SERVICES = {
  attestation: {
    title:   'شهادة السكنى',
    badge:   'Attestation de résidence',
    url:     'portail.ma/commune/attestation-residence',
    greeting:'واخا سنعاونك فشهادة السكنى هيا نبداو',
    fields: [
      { key:'nom',         label:'NOM COMPLET',    ar:'الاسم الكامل',  hint:'MOHAMMED AL FASSI', question:'شنو هو اسمك الكامل قول الاسم الشخصي واسم العائلة', isFullName:true },
      { key:'cin_letters', label:'CIN — LETTRES',  ar:'حروف البطاقة',  hint:'AB',                question:'قول الحروف ديال البطاقة بالفرانساوي',              isCinLetters:true },
      { key:'cin_numbers', label:'CIN — CHIFFRES', ar:'أرقام البطاقة', hint:'123456',            question:'دابا قول الأرقام ديال البطاقة',                     isCinNumbers:true },
      { key:'adr',         label:'ADRESSE',        ar:'العنوان',        hint:'شارع الحسن الثاني', question:'شنو هو عنوانك الكامل'   },
      { key:'ville',       label:'VILLE',          ar:'المدينة',        hint:'خريبكة',            question:'فأي مدينة كاتسكن',       isCity:true },
      { key:'tel',         label:'TÉLÉPHONE',      ar:'رقم الهاتف',    hint:'0612345678',        question:'شنو هو رقم تيليفونك'    },
    ]
  },
  naissance: {
    title:   'شهادة الميلاد',
    badge:   'Acte de naissance',
    url:     'portail.ma/etat-civil/naissance',
    greeting:'واخا سنعاونك فشهادة الازدياد هيا نبداو',
    fields: [
      { key:'nom',         label:'NOM COMPLET',    ar:'الاسم الكامل',  hint:'MOHAMMED AL FASSI', question:'شنو هو اسمك الكامل قول الاسم الشخصي واسم العائلة', isFullName:true },
      { key:'cin_letters', label:'CIN — LETTRES',  ar:'حروف البطاقة',  hint:'AB',                question:'قول الحروف ديال البطاقة بالفرانساوي',              isCinLetters:true },
      { key:'cin_numbers', label:'CIN — CHIFFRES', ar:'أرقام البطاقة', hint:'123456',            question:'دابا قول الأرقام ديال البطاقة',                     isCinNumbers:true },
      { key:'naissance',   label:'DATE NAISSANCE', ar:'تاريخ الميلاد', hint:'JJ/MM/AAAA',        question:'فوقاش ولدتي عطيني تاريخ الميلاد ديالك' },
      { key:'lieu',        label:'LIEU NAISSANCE', ar:'مكان الازدياد', hint:'خريبكة',            question:'فأي مدينة ولدتي',        isCity:true },
      { key:'tel',         label:'TÉLÉPHONE',      ar:'رقم الهاتف',    hint:'0612345678',        question:'شنو هو رقم تيليفونك'    },
    ]
  },
  cin: {
    title:   'البطاقة الوطنية',
    badge:   'Renouvellement / Première demande CNIE',
    url:     'www.cnie.ma/request-type',
    greeting:'واخا سنعاونك فالبطاقة الوطنية هيا نبداو',
    fields: [
      { key:'nom',         label:'NOM DE FAMILLE', ar:'اسم العائلة',           hint:'AL FASSI',   question:'شنو هو اسم عائلتك',                            isLastName:true  },
      { key:'prenom',      label:'PRÉNOM',          ar:'الاسم الشخصي',          hint:'MOHAMMED',   question:'شنو هو اسمك الشخصي',                           isFirstName:true },
      { key:'cin_letters', label:'CIN — LETTRES',  ar:'حروف البطاقة القديمة', hint:'AB',          question:'قول الحروف ديال البطاقة القديمة بالفرانساوي',  isCinLetters:true },
      { key:'cin_numbers', label:'CIN — CHIFFRES', ar:'أرقام البطاقة القديمة',hint:'123456',      question:'دابا قول الأرقام ديال البطاقة القديمة',         isCinNumbers:true },
      { key:'motif',       label:'MOTIF',           ar:'سبب الطلب',             hint:'EXPIRATION', question:'علاش بغيتي تجدد البطاقة لأن منتهية ولا ضاعت ولا تلفت', isMotif:true },
      { key:'naissance',   label:'DATE NAISSANCE', ar:'تاريخ الميلاد',         hint:'JJ/MM/AAAA', question:'فوقاش ولدتي عطيني تاريخ الميلاد ديالك' },
      { key:'ville',       label:'VILLE',           ar:'المدينة',               hint:'خريبكة',     question:'فأي مدينة كاتسكن',                             isCity:true      },
      { key:'tel',         label:'TÉLÉPHONE',      ar:'رقم الهاتف',            hint:'0612345678', question:'شنو هو رقم تيليفونك'   },
    ]
  },
  revenu: {
    title:   'شهادة الدخل',
    badge:   'Attestation de revenu',
    url:     'portail.ma/emploi/revenu',
    greeting:'واخا سنعاونك فشهادة الدخل هيا نبداو',
    fields: [
      { key:'nom',         label:'NOM COMPLET',    ar:'الاسم الكامل',  hint:'MOHAMMED AL FASSI', question:'شنو هو اسمك الكامل قول الاسم الشخصي واسم العائلة', isFullName:true },
      { key:'cin_letters', label:'CIN — LETTRES',  ar:'حروف البطاقة',  hint:'AB',                question:'قول الحروف ديال البطاقة بالفرانساوي',              isCinLetters:true },
      { key:'cin_numbers', label:'CIN — CHIFFRES', ar:'أرقام البطاقة', hint:'123456',            question:'دابا قول الأرقام ديال البطاقة',                     isCinNumbers:true },
      { key:'emploi',      label:'EMPLOYEUR',      ar:'جهة العمل',     hint:'OCP خريبكة',        question:'فأي شركة أو مؤسسة كاتخدم' },
      { key:'salaire',     label:'SALAIRE (MAD)',  ar:'الراتب الشهري', hint:'5000',              question:'شحال هو الراتب الشهري ديالك' },
      { key:'tel',         label:'TÉLÉPHONE',      ar:'رقم الهاتف',    hint:'0612345678',        question:'شنو هو رقم تيليفونك' },
    ]
  }
};


/* ══════════════════════════════════════════════════
   6. APP STATE
   ══════════════════════════════════════════════════ */
const AppState = {
  phase:            'idle',
  service:          null,
  fieldIndex:       0,
  currentField:     null,
  answers:          {},
  pendingCinLetters:null,
  sttHandle:        null,
  startTime:        null,
};


/* ══════════════════════════════════════════════════
   7. FORM MANAGER
   ══════════════════════════════════════════════════ */
const FormManager = {

  render(serviceKey) {
    const svc = SERVICES[serviceKey];
    const container = document.getElementById('form-fields-container');
    container.innerHTML = '';

    // Submit button: hidden at start, revealed only when all fields filled
    const btn = document.getElementById('form-submit-btn');
    if (btn) { btn.style.display = 'none'; btn.disabled = true; }

    let i = 0;
    while (i < svc.fields.length) {
      const field = svc.fields[i];

      // ── CIN letters + numbers: side-by-side ──
      if (field.isCinLetters && svc.fields[i+1]?.isCinNumbers) {
        const wrap = document.createElement('div');
        wrap.className = 'cin-row';
        wrap.id = 'field-group-cin-row';

        [svc.fields[i], svc.fields[i+1]].forEach(f => {
          const badge = f.isCinLetters
            ? '<span class="field-lang-badge fr">FR</span>'
            : '<span class="field-lang-badge ar">AR</span>';
          const part = document.createElement('div');
          part.className = 'field-group cin-part';
          part.id = `field-group-${f.key}`;
          part.innerHTML = `
            <div class="field-label-row">
              <span class="field-label">${f.label}</span>${badge}
              <span class="field-ar-label">${f.ar}</span>
            </div>
            <input type="text" id="field-${f.key}" name="${f.key}"
              class="field-input cin-part-input" placeholder="${f.hint}" autocomplete="off"/>`;
          wrap.appendChild(part);
        });

        // merged CIN row (hidden until filled)
        const merged = document.createElement('div');
        merged.id = 'field-group-cin-merged';
        merged.className = 'field-group field-group-cin-merged';
        merged.style.display = 'none';
        merged.innerHTML = `
          <div class="field-label-row">
            <span class="field-label">N° CIN COMPLET</span>
            <span class="field-ar-label">رقم البطاقة الكامل</span>
          </div>
          <input type="text" id="field-cin" name="cin"
            class="field-input cin-merged-input" placeholder="AB123456" readonly/>`;
        wrap.appendChild(merged);
        container.appendChild(wrap);
        i += 2; continue;
      }

      // ── Name fields: FR + AR side-by-side ──
      if (field.isFullName || field.isLastName || field.isFirstName) {
        const group = document.createElement('div');
        group.className = 'field-group field-group-name';
        group.id = `field-group-${field.key}`;
        group.innerHTML = `
          <div class="field-label-row">
            <span class="field-label">${field.label}</span>
            <span class="field-ar-label">${field.ar}</span>
          </div>
          <div class="name-inputs-row">
            <div class="name-input-wrap">
              <span class="name-lang-tag">FR</span>
              <input type="text" id="field-${field.key}" name="${field.key}"
                class="field-input name-input-fr" placeholder="${field.hint}" autocomplete="off"/>
            </div>
            <div class="name-input-wrap">
              <span class="name-lang-tag ar">AR</span>
              <input type="text" id="field-${field.key}-ar" name="${field.key}_ar"
                class="field-input name-input-ar" placeholder="بالعربية" autocomplete="off" readonly/>
            </div>
          </div>`;
        container.appendChild(group);
        i++; continue;
      }

      // ── Standard field ──
      const group = document.createElement('div');
      group.className = 'field-group';
      group.id = `field-group-${field.key}`;
      group.innerHTML = `
        <div class="field-label-row">
          <span class="field-label">${field.label}</span>
          <span class="field-ar-label">${field.ar}</span>
        </div>
        <input type="text" id="field-${field.key}" name="${field.key}"
          class="field-input" placeholder="${field.hint}" autocomplete="off"/>`;
      container.appendChild(group);
      i++;
    }

    document.getElementById('form-title').textContent  = svc.title;
    document.getElementById('form-badge').textContent  = svc.badge;
    document.getElementById('browser-url').textContent = svc.url;
    this.updateProgress(serviceKey);
  },

  fillName(key, valueFR, valueAR) {
    const fr = document.getElementById(`field-${key}`);
    const ar = document.getElementById(`field-${key}-ar`);
    if (fr) { fr.value = valueFR; fr.classList.add('filled'); fr.classList.remove('active-field'); }
    if (ar) { ar.value = valueAR; ar.classList.add('filled'); }
    fr?.scrollIntoView({behavior:'smooth', block:'center'});
  },

  fillField(key, value) {
    const el = document.getElementById(`field-${key}`);
    if (!el) return;
    el.value = value;
    el.classList.add('filled'); el.classList.remove('active-field');
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.scrollIntoView({behavior:'smooth', block:'center'});
  },

  setActive(key) {
    document.querySelectorAll('.field-input').forEach(e=>e.classList.remove('active-field'));
    const el = document.getElementById(`field-${key}`);
    if (el && !el.classList.contains('filled')) {
      el.classList.add('active-field');
      el.scrollIntoView({behavior:'smooth', block:'center'});
    }
  },

  filledCount(sk) {
    return SERVICES[sk].fields.filter(f=>{
      const el = document.getElementById(`field-${f.key}`);
      return el && el.value.trim().length > 0;
    }).length;
  },

  updateProgress(sk) {
    const total  = SERVICES[sk].fields.length;
    const filled = this.filledCount(sk);
    const pct    = total>0 ? Math.round((filled/total)*100) : 0;
    document.getElementById('form-progress-fill').style.width  = pct+'%';
    document.getElementById('form-progress-label').textContent = `${filled} / ${total}`;

    const btn = document.getElementById('form-submit-btn');
    if (!btn) return;
    if (filled >= total) {
      // All filled: show and enable button
      btn.style.display = '';
      btn.disabled = false;
      btn.scrollIntoView({behavior:'smooth', block:'nearest'});
    } else {
      btn.disabled = true;
      // Keep hidden until complete — prevents premature trigger
    }
  },

  collect() { return new FormData(document.getElementById('admin-form')); }
};


/* ══════════════════════════════════════════════════
   8. VOICE FLOW
   Key discipline: every branch ends with
     await TTSQueue.speak(...)
     await delay(150)          ← lets audio finish cleanly
     AppState.fieldIndex++
     return this.collectNext()
   collectNext() begins with speak(question) — which
   queues AFTER the previous speak, so zero overlap.
   ══════════════════════════════════════════════════ */
const VoiceFlow = {

  async greet() {
    AppState.phase = 'greeting';
    UI.setStatus('processing', 'مرحبا');
    UI.setFooterStrip('', 'مرحبا بيك في يسّر');
    await TTSQueue.speak('مرحبا بيك شنو تبغي دير اليوم');
    await this.listenForIntent();
  },

  async listenForIntent() {
    AppState.phase = 'listening-intent';
    UI.showState('state-listening');
    UI.setStatus('listening', 'كنسمع');
    UI.setMicState('listening');
    UI.setFooterStrip('listening', 'كنسمعك تكلم دابا');

    const t = await this._listenAR(interim => {
      document.getElementById('live-transcript').innerHTML =
        interim + '<span class="transcript-cursor">|</span>';
    });

    if (!t) {
      await TTSQueue.speak('ما سمعتكش عاود حاول');
      return this.listenForIntent();
    }

    document.getElementById('live-transcript').textContent = t;
    UI.showState('state-processing');
    UI.setMicState('processing');
    UI.setStatus('processing', 'كنفهم');

    const { intent, confidence } = await GPT.intent(t);

    // والو / تا حاجة → polite goodbye, stay idle
    if (intent === 'nothing') {
      await TTSQueue.speak('واخا مشكلة ماكاينش يسّر في خدمتك تصبح على خير');
      UI.setMicState('idle');
      UI.setStatus('ready', 'واخا');
      UI.setFooterStrip('', 'اضغط وتكلم');
      AppState.phase = 'idle';
      return;
    }

    if (!SERVICES[intent] || confidence < 0.5) {
      await TTSQueue.speak('ما فهمتكش قول ليا مثلا ورقة الدار ولا تجديد لاكارط');
      return this.listenForIntent();
    }

    await this.startService(intent);
  },

  async startService(key) {
    AppState.service          = key;
    AppState.fieldIndex       = 0;
    AppState.answers          = {};
    AppState.pendingCinLetters= null;
    AppState.startTime        = Date.now();

    const svc = SERVICES[key];
    FormManager.render(key);
    UI.showState('state-form');
    UI.setBrowserUrl(svc.url, true);
    UI.setHeaderContext(svc.title);
    UI.setStatus('processing', svc.title);

    await TTSQueue.speak(svc.greeting);
    await this.collectNext();
  },

  async collectNext() {
    const svc = SERVICES[AppState.service];
    if (AppState.fieldIndex >= svc.fields.length) return this.finishForm();

    const field = svc.fields[AppState.fieldIndex];
    AppState.currentField = field.key;
    AppState.phase = 'listening-field';

    UI.setVoiceQuestion(`${field.label} — ${field.ar}`, field.question);
    FormManager.setActive(field.key);
    UI.showTextFallback(true);
    document.getElementById('text-input').placeholder = field.hint;

    // Speak question — queued, zero overlap guaranteed
    await TTSQueue.speak(field.question);
    UI.setStatus('listening', field.label);
    UI.setMicState('listening');
    UI.setFooterStrip('listening', field.question);

    // ══════════════════════════
    // FULL NAME (attestation / naissance / revenu)
    // Ask once, extract nom + prenom together
    // ══════════════════════════
    if (field.isFullName) {
      const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول اسمك الكامل'); return this.collectNext(); }

      UI.setMicState('processing');
      const parsed = await GPT.extractFullName(t);
      if (!parsed || (!parsed.nom && !parsed.prenom)) {
        await TTSQueue.speak('ما فهمتش عاود قول اسمك الكامل من فضلك');
        return this.collectNext();
      }

      // Build combined full name for the single field
      const fullFR = [parsed.prenom, parsed.nom].filter(Boolean).join(' ').trim();
      const fullAR = [parsed.prenom_ar, parsed.nom_ar].filter(Boolean).join(' ').trim() || t.trim();
      const confirmQ = parsed.question || `واش اسمك هو ${fullAR}`;

      AppState.phase = 'confirming-name';
      UI.setVoiceQuestion(field.label, confirmQ);
      UI.setFooterStrip('listening', confirmQ);
      await TTSQueue.speak(confirmQ);
      UI.setMicState('listening');

      const conf = await this._listenAR(i => UI.setFooterStrip('listening', i));
      const ans  = await GPT.yesNo(conf || '');

      if (ans === 'no') {
        await TTSQueue.speak('واخا عاود قول اسمك الكامل بوضوح');
        AppState.phase = 'listening-field';
        return this.collectNext();
      }

      FormManager.fillName(field.key, fullFR, fullAR);
      AppState.answers[field.key] = fullFR;
      FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success', `${field.label}: ${fullFR}`);
      UI.setMicState('idle');
      await TTSQueue.speak('مزيان');
      await delay(150);
      AppState.fieldIndex++;
      AppState.phase = 'listening-field';
      return this.collectNext();
    }

    // ══════════════════════════
    // LAST NAME only
    // ══════════════════════════
    if (field.isLastName) {
      const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول اسم العائلة'); return this.collectNext(); }

      UI.setMicState('processing');
      const raw = t.trim().replace(/[؟?!،,.:;]/g,'').trim();
      if (!raw) { await TTSQueue.speak('ما فهمتش عاود قول اسم العائلة'); return this.collectNext(); }

      const { normalised, question: confirmQ } = await GPT.normaliseLastName(raw);
      AppState.phase = 'confirming-name';
      UI.setVoiceQuestion(field.label, confirmQ);
      UI.setFooterStrip('listening', confirmQ);
      await TTSQueue.speak(confirmQ);
      UI.setMicState('listening');

      const conf = await this._listenAR(i => UI.setFooterStrip('listening', i));
      const ans  = await GPT.yesNo(conf || '');

      if (ans === 'no') {
        await TTSQueue.speak('واخا عاود قول اسم العائلة بوضوح');
        AppState.phase = 'listening-field';
        return this.collectNext();
      }
      FormManager.fillName(field.key, normalised, raw);
      AppState.answers[field.key] = normalised;
      FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success', `${field.label}: ${normalised}`);
      UI.setMicState('idle');
      await TTSQueue.speak('مزيان');
      await delay(150);
      AppState.fieldIndex++;
      AppState.phase = 'listening-field';
      return this.collectNext();
    }

    // ══════════════════════════
    // FIRST NAME — fuzzy match
    // ══════════════════════════
    if (field.isFirstName) {
      const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول اسمك الشخصي'); return this.collectNext(); }

      UI.setMicState('processing');
      const raw = t.trim().replace(/[؟?!،,.:;]/g,'').trim();
      if (!raw) { await TTSQueue.speak('ما فهمتش عاود قول اسمك الشخصي'); return this.collectNext(); }

      const { suggested, question: confirmQ } = await GPT.fuzzyFirstName(raw);
      AppState.phase = 'confirming-name';
      UI.setVoiceQuestion(field.label, confirmQ);
      UI.setFooterStrip('listening', confirmQ);
      await TTSQueue.speak(confirmQ);
      UI.setMicState('listening');

      const conf = await this._listenAR(i => UI.setFooterStrip('listening', i));
      const ans  = await GPT.yesNo(conf || '');

      if (ans === 'no') {
        await TTSQueue.speak('واخا عاود قول اسمك الشخصي بوضوح');
        AppState.phase = 'listening-field';
        return this.collectNext();
      }
      FormManager.fillName(field.key, suggested, raw);
      AppState.answers[field.key] = suggested;
      FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success', `${field.label}: ${suggested}`);
      UI.setMicState('idle');
      await TTSQueue.speak('مزيان');
      await delay(150);
      AppState.fieldIndex++;
      AppState.phase = 'listening-field';
      return this.collectNext();
    }

    // ══════════════════════════
    // CIN LETTERS — fr-FR STT
    // ══════════════════════════
    if (field.isCinLetters) {
      const t = await this._listenFR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول الحروف'); return this.collectNext(); }

      UI.setMicState('processing');
      const letters = await GPT.extractCINLetters(t);
      if (!letters) { await TTSQueue.speak('ما فهمتش عاود قول الحروف بالفرانساوي'); return this.collectNext(); }

      AppState.pendingCinLetters = letters;
      FormManager.fillField('cin_letters', letters);
      await TTSQueue.speak('مزيان ' + letters.split('').join(' '));
      await delay(150);
      AppState.fieldIndex++;
      return this.collectNext();
    }

    // ══════════════════════════
    // CIN NUMBERS — merge with letters
    // ══════════════════════════
    if (field.isCinNumbers) {
      const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول الأرقام'); return this.collectNext(); }

      UI.setMicState('processing');
      const { value: digits } = await GPT.extract(t, 'cin_numbers');
      if (!digits) { await TTSQueue.speak('ما فهمتش عاود قول الأرقام'); return this.collectNext(); }

      const full = await GPT.mergeCIN(AppState.pendingCinLetters||'', digits);
      FormManager.fillField('cin_numbers', digits);
      FormManager.fillField('cin', full);
      AppState.answers['cin'] = full;
      AppState.pendingCinLetters = null;

      const merged = document.getElementById('field-group-cin-merged');
      if (merged) merged.style.display = '';

      FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success', 'CIN: ' + full);
      UI.setMicState('idle');
      await TTSQueue.speak('مزيان رقم البطاقة هو ' + full.split('').join(' '));
      await delay(150);
      AppState.fieldIndex++;
      return this.collectNext();
    }

    // ══════════════════════════
    // CITY — fuzzy match
    // ══════════════════════════
    if (field.isCity) {
      const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول المدينة'); return this.collectNext(); }

      UI.setMicState('processing');
      const raw = t.trim().replace(/[؟?!،,.:;]/g,'').trim();
      const { suggested, suggested_fr, question: confirmQ } = await GPT.fuzzyCity(raw);
      AppState.phase = 'confirming-name';
      UI.setVoiceQuestion(field.label, confirmQ);
      UI.setFooterStrip('listening', confirmQ);
      await TTSQueue.speak(confirmQ);
      UI.setMicState('listening');

      const conf = await this._listenAR(i => UI.setFooterStrip('listening', i));
      const ans  = await GPT.yesNo(conf || '');

      if (ans === 'no') {
        await TTSQueue.speak('واخا عاود قول المدينة');
        AppState.phase = 'listening-field';
        return this.collectNext();
      }
      FormManager.fillField(field.key, suggested_fr);
      AppState.answers[field.key] = suggested_fr;
      const el = document.getElementById(`field-${field.key}`);
      if (el) el.setAttribute('data-ar', suggested);
      FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success', `${field.label}: ${suggested}`);
      UI.setMicState('idle');
      await TTSQueue.speak('مزيان ' + suggested);
      await delay(150);
      AppState.fieldIndex++;
      AppState.phase = 'listening-field';
      return this.collectNext();
    }

    // ══════════════════════════
    // MOTIF — rich Darija aliases
    // ══════════════════════════
    if (field.isMotif) {
      const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
      if (!t) { await TTSQueue.speak('ما سمعتكش عاود قول السبب'); return this.collectNext(); }

      UI.setMicState('processing');
      const { value, label_ar, confidence } = await GPT.extractMotif(t);
      if (!value || confidence < 0.4) {
        await TTSQueue.speak('ما فهمتش قول منتهية ولا ضاعت ولا تلفت');
        return this.collectNext();
      }
      FormManager.fillField(field.key, value);
      AppState.answers[field.key] = value;
      FormManager.updateProgress(AppState.service);
      UI.setFooterStrip('success', `${field.label}: ${label_ar}`);
      UI.setMicState('idle');
      await TTSQueue.speak('مزيان ' + label_ar);
      await delay(150);
      AppState.fieldIndex++;
      AppState.phase = 'listening-field';
      return this.collectNext();
    }

    // ══════════════════════════
    // STANDARD field
    // ══════════════════════════
    const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
    if (!t) { await TTSQueue.speak('ما سمعتكش عاود جاوب'); return this.collectNext(); }

    UI.setMicState('processing');
    UI.setStatus('processing', 'كنفهم');

    const { value, confidence } = await GPT.extract(t, field.key);
    if (!value || confidence < 0.35) {
      await TTSQueue.speak('ما فهمتش مزيان عاود قول');
      return this.collectNext();
    }

    FormManager.fillField(field.key, value);
    AppState.answers[field.key] = value;
    FormManager.updateProgress(AppState.service);
    UI.setFooterStrip('success', `${field.label}: ${value}`);
    UI.setMicState('idle');
    UI.setStatus('ready', 'مزيان');
    await TTSQueue.speak('مزيان ' + value);
    await delay(150);
    AppState.fieldIndex++;
    AppState.phase = 'listening-field';
    return this.collectNext();
  },

  /* ── All fields done ── */
  async finishForm() {
    AppState.phase = 'done';
    UI.setStatus('ready', 'واخا');
    UI.showTextFallback(false);
    UI.setFooterStrip('success', 'تم جمع كل المعلومات');
    UI.setMicState('idle');
    UI.setVoiceQuestion('', 'قول ارسل أو اضغط الزر');
    document.getElementById('form-submit-btn')?.scrollIntoView({behavior:'smooth'});
    await TTSQueue.speak('مزيان تم جمع كل المعلومات قول ارسل أو اضغط على زر الإرسال');
    await this.listenForSubmit();
  },

  /* ── Voice submit ── */
  async listenForSubmit() {
    AppState.phase = 'listening-submit';
    UI.setMicState('listening');
    UI.setFooterStrip('listening', 'قول ارسل أو سيفط');

    const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
    if (!t) { UI.setMicState('idle'); return; }

    const ok = await GPT.detectSubmit(t);
    UI.setMicState('idle');
    if (ok) {
      document.getElementById('admin-form')
        .dispatchEvent(new Event('submit',{bubbles:true, cancelable:true}));
    } else {
      UI.setFooterStrip('success', 'اضغط زر الإرسال متى كنت مستعد');
    }
  },

  /* ── After success: ask if user needs anything else ── */
  async askAnythingElse() {
    AppState.phase = 'asking-more';
    UI.setMicState('listening');
    UI.setFooterStrip('listening', 'واش كاين شي حاجة أخرى');
    await TTSQueue.speak('واش كاين شي حاجة أخرى نعاونك فيها');
    UI.setMicState('listening');

    const t = await this._listenAR(i => UI.setFooterStrip('listening', i));
    const ans = await GPT.yesNo(t || '');

    if (ans === 'yes') {
      // Start fresh
      await TTSQueue.speak('واخا قول ليا شنو تبغي');
      resetApp();
      await VoiceFlow.listenForIntent();
    } else {
      // Goodbye
      await TTSQueue.speak('واخا يسّر كان في خدمتك تصبح على خير ونهارك مبارك');
      UI.setMicState('idle');
      UI.setStatus('ready', 'واخا');
      UI.setFooterStrip('', 'اضغط وتكلم');
      AppState.phase = 'idle';
    }
  },

  _listenAR(onInterim) {
    return new Promise(resolve => {
      AppState.sttHandle = AzureSTT.listenAR(resolve, onInterim);
    });
  },
  _listenFR(onInterim) {
    return new Promise(resolve => {
      AppState.sttHandle = AzureSTT.listenFR(resolve, onInterim);
    });
  },
  stopListening() {
    if (AppState.sttHandle?.stop) { AppState.sttHandle.stop(); AppState.sttHandle = null; }
  }
};


/* ══════════════════════════════════════════════════
   9. UI
   ══════════════════════════════════════════════════ */
const UI = {
  showState(id) {
    document.querySelectorAll('.main-state').forEach(s=>s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
  },
  setStatus(type, label) {
    document.getElementById('status-dot').className     = 'status-dot '+(type==='ready'?'':type);
    document.getElementById('status-label').textContent = label;
  },
  setMicState(state) {
    const btn  = document.getElementById('mic-btn');
    const dflt = document.getElementById('mic-icon-default');
    const stop = document.getElementById('mic-icon-stop');
    const lbl  = document.getElementById('mic-label');
    const bars = document.querySelectorAll('.fw-bar');
    btn.className = 'mic-btn';
    if (state==='listening') {
      btn.classList.add('listening');
      dflt.style.display='none'; stop.style.display='block';
      lbl.textContent='اضغط باش توقف'; lbl.style.color='#ef4444';
      bars.forEach(b=>b.classList.add('active'));
    } else if (state==='processing') {
      btn.classList.add('processing');
      dflt.style.display='block'; stop.style.display='none';
      lbl.textContent='كنفهم'; lbl.style.color='#b45309';
      bars.forEach(b=>b.classList.remove('active'));
    } else {
      dflt.style.display='block'; stop.style.display='none';
      lbl.textContent='اضغط وتكلم'; lbl.style.color='';
      bars.forEach(b=>b.classList.remove('active'));
    }
  },
  setFooterStrip(type, text) {
    document.getElementById('footer-strip').className        = 'footer-strip '+(type||'');
    document.getElementById('footer-strip-text').textContent = text;
  },
  setBrowserUrl(url, loading=false) {
    const el=document.getElementById('browser-url');
    const ld=document.getElementById('browser-loader');
    el.textContent=url;
    el.classList.toggle('loaded',!loading);
    ld.classList.toggle('loading',loading);
    if(loading) setTimeout(()=>{ld.classList.remove('loading');el.classList.add('loaded');},1200);
  },
  setHeaderContext(text) {
    const el=document.getElementById('header-context');
    el.textContent=text; el.classList.add('active-context');
  },
  setVoiceQuestion(label,q) {
    document.getElementById('vq-field-label').textContent=label;
    document.getElementById('vq-question').textContent=q;
  },
  showTextFallback(show) {
    document.getElementById('text-fallback').style.display=show?'flex':'none';
    if(show) setTimeout(()=>document.getElementById('text-input').focus(),100);
  },
  toast(msg, duration=2500) {
    const t=document.getElementById('toast');
    t.textContent=msg; t.style.display='block';
    clearTimeout(t._timer);
    t._timer=setTimeout(()=>t.style.display='none',duration);
  },

  /* Green success splash screen */
  showSuccessSplash(refNumber, savedMin) {
    // Try existing state-success element first, otherwise create overlay
    let splash = document.getElementById('state-success');
    if (!splash) {
      splash = document.createElement('div');
      splash.id = 'state-success';
      splash.className = 'main-state';
      document.querySelector('.main-content')?.appendChild(splash);
    }
    splash.innerHTML = `
      <div class="success-splash">
        <div class="success-checkmark">
          <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="50" cy="50" r="46" stroke="white" stroke-width="4" fill="none" opacity="0.3"/>
            <path class="check-path" d="M25 52 L42 69 L75 33"
              stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
          </svg>
        </div>
        <h2 class="success-title">تم الإرسال بنجاح</h2>
        <p class="success-subtitle">طلبك وصل وغادي تتواصل معاك</p>
        <div class="success-ref">${refNumber}</div>
        <div class="success-time">${savedMin}</div>
        <button class="success-new-btn" onclick="VoiceFlow.askAnythingElse()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
          </svg>
          طلب جديد
        </button>
      </div>`;
    this.showState('state-success');
  }
};


/* ══════════════════════════════════════════════════
   10. EVENT HANDLERS
   ══════════════════════════════════════════════════ */
function handleMicPress() {
  const ph = AppState.phase;
  if (['listening-intent','listening-field','confirming-name',
       'listening-submit','asking-more'].includes(ph)) {
    VoiceFlow.stopListening();
    TTSQueue.cancel();
    UI.setMicState('idle');
    UI.setFooterStrip('','اضغط وتكلم');
    AppState.phase = 'idle';
    return;
  }
  if (ph==='idle'||ph==='done') VoiceFlow.greet();
}

function selectService(key) {
  VoiceFlow.stopListening(); TTSQueue.cancel();
  VoiceFlow.startService(key);
}

function submitTextInput() {
  const input = document.getElementById('text-input');
  const val   = input.value.trim();
  if (!val) return;
  const ph = AppState.phase;

  if (ph==='listening-intent'||ph==='idle') {
    VoiceFlow.stopListening();
    UI.showState('state-processing'); UI.setMicState('processing');
    GPT.intent(val).then(({intent,confidence})=>{
      if(intent==='nothing'){
        TTSQueue.speak('واخا مشكلة ماكاينش يسّر في خدمتك');
        UI.setMicState('idle'); AppState.phase='idle';
      } else if(SERVICES[intent]&&confidence>=0.5){
        VoiceFlow.startService(intent);
      } else {
        UI.toast('ما فهمتكش عاود حاول'); UI.showState('state-idle'); UI.setMicState('idle');
      }
    });
  } else if (ph==='listening-field') {
    VoiceFlow.stopListening();
    const field = SERVICES[AppState.service]?.fields[AppState.fieldIndex];
    if (!field) return;
    GPT.extract(val,field.key).then(({value,confidence})=>{
      if(!value||confidence<0.35){UI.toast('ما فهمتش عاود');return;}
      FormManager.fillField(field.key,value);
      AppState.answers[field.key]=value;
      FormManager.updateProgress(AppState.service);
      AppState.fieldIndex++;
      input.value='';
      setTimeout(()=>VoiceFlow.collectNext(),200);
    });
  } else if (ph==='done'||ph==='listening-submit') {
    GPT.detectSubmit(val).then(yes=>{
      if(yes) document.getElementById('admin-form')
        .dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    });
  }
  input.value='';
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const fd=FormManager.collect();
  const payload={};
  for(const[k,v] of fd.entries()) payload[k]=v;
  console.log('[Yassir] Submit payload:',payload);

  const btn=document.getElementById('form-submit-btn');
  if(btn){
    btn.innerHTML=`<div style="width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;"></div><span>كنرسل</span>`;
    btn.style.gap='10px'; btn.disabled=true;
  }

  await delay(1600);

  const elapsed = AppState.startTime ? Math.round((Date.now()-AppState.startTime)/1000) : 0;
  const saved   = Math.max(15-Math.round(elapsed/60),2);
  const ref     = 'YSR-2026-'+(4800+Math.floor(Math.random()*200));

  // Update legacy elements if they exist
  const scNum = document.getElementById('sc-number');
  const stTime = document.getElementById('st-time');
  if (scNum) scNum.textContent = ref;
  if (stTime) stTime.textContent = 'وفرتي '+saved+' دقيقة';

  // Show green splash
  UI.showSuccessSplash(ref, 'وفرتي '+saved+' دقيقة');
  UI.setStatus('ready','تم');
  UI.setFooterStrip('success','تم إرسال الطلب بنجاح');
  await TTSQueue.speak('مزيان تم إرسال طلبك غادي يوصلك رقم المتابعة');

  // Ask if they need anything else
  await delay(800);
  await VoiceFlow.askAnythingElse();
}

function resetApp() {
  VoiceFlow.stopListening(); TTSQueue.cancel();
  Object.assign(AppState,{
    phase:'idle', service:null, fieldIndex:0,
    answers:{}, currentField:null, pendingCinLetters:null, startTime:null
  });
  UI.showState('state-idle'); UI.setMicState('idle');
  UI.setStatus('ready','واخا'); UI.setFooterStrip('','اضغط وتكلم');
  UI.showTextFallback(false);
  const ctx=document.getElementById('header-context');
  ctx.textContent='مساعدك الإداري الذكي'; ctx.classList.remove('active-context');
  const btn=document.getElementById('form-submit-btn');
  if(btn){
    btn.innerHTML=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>إرسال الطلب`;
    btn.disabled=true; btn.style.gap=''; btn.style.display='none';
  }
}


/* ══════════════════════════════════════════════════
   11. HELPERS + INIT
   ══════════════════════════════════════════════════ */
function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

document.addEventListener('DOMContentLoaded',()=>{
  // Ensure submit button starts hidden
  const btn = document.getElementById('form-submit-btn');
  if (btn) btn.style.display = 'none';
  setTimeout(()=>VoiceFlow.greet(), 800);
});