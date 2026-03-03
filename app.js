/**
 * OASIS PHARMACY TRACKER v9.0.0
 * GS1 Barcode Scanner with Enhanced Export
 * 
 * FEATURES:
 * - GS1 Parsing (GTIN, Batch, Expiry)
 * - Multi-scan mode for product identification
 * - Enhanced master data (RMS, Alshaya Code, Brand, Supplier, etc.)
 * - Store name tracking
 * - CSV Export matching company template
 * - Cloud Sync, Dark Mode, Categories, Suppliers
 * 
 * By VYSAKH
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  DB_NAME: 'OasisPharmacyDB',
  DB_VERSION: 6,
  EXPIRY_SOON_DAYS: 90,
  VERSION: '9.0.0',
  CLOUD_PREFIX: 'oasis_backup_',
  STORE_NAME: 'OASIS PHARMACY' // Default store name
};

// ============================================
// APPLICATION STATE
// ============================================
const App = {
  db: null,
  masterIndex: new Map(),
  masterRMS: new Map(),
  masterVariants: new Map(),
  masterFull: new Map(), // Full product details
  settings: {
    apiEnabled: true,
    hapticEnabled: true,
    darkMode: false,
    storeName: CONFIG.STORE_NAME
  },
  scanner: {
    active: false,
    instance: null
  },
  filter: 'all',
  search: '',
  editingId: null,
  pendingItem: null,
  scanMode: 'normal',
  
  categories: [
    { id: 'medicine', name: 'Medicine', icon: '💊', color: '#6C63FF' },
    { id: 'cosmetics', name: 'Cosmetics', icon: '🧴', color: '#F783AC' },
    { id: 'vitamins', name: 'Vitamins', icon: '💪', color: '#FFA94D' },
    { id: 'baby', name: 'Baby Care', icon: '👶', color: '#81ECEC' },
    { id: 'medical', name: 'Medical Devices', icon: '🩺', color: '#00B894' },
    { id: 'other', name: 'Other', icon: '📦', color: '#B2BEC3' }
  ],
  
  suppliers: []
};

// ============================================
// DARK MODE
// ============================================
const DarkMode = {
  init() {
    const saved = localStorage.getItem('darkMode');
    if (saved === 'true') this.enable();
  },
  toggle() {
    if (document.body.classList.contains('dark-mode')) this.disable();
    else this.enable();
  },
  enable() {
    document.body.classList.add('dark-mode');
    App.settings.darkMode = true;
    localStorage.setItem('darkMode', 'true');
    document.getElementById('toggleDarkMode')?.classList.add('on');
  },
  disable() {
    document.body.classList.remove('dark-mode');
    App.settings.darkMode = false;
    localStorage.setItem('darkMode', 'false');
    document.getElementById('toggleDarkMode')?.classList.remove('on');
  }
};

// ============================================
// CLOUD SYNC
// ============================================
const CloudSync = {
  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  },
  
  async save(code) {
    if (!code || code.length < 4) throw new Error('Invalid code');
    code = code.toUpperCase().trim();
    
    const data = {
      version: CONFIG.VERSION,
      timestamp: Date.now(),
      history: await DB.getAllHistory(),
      master: await DB.getAllMaster(),
      suppliers: App.suppliers,
      settings: App.settings
    };
    
    localStorage.setItem(CONFIG.CLOUD_PREFIX + code, JSON.stringify(data));
    return { code, itemCount: data.history.length };
  },
  
  async load(code) {
    if (!code || code.length < 4) throw new Error('Invalid code');
    code = code.toUpperCase().trim();
    
    const stored = localStorage.getItem(CONFIG.CLOUD_PREFIX + code);
    if (!stored) throw new Error('No backup found');
    
    const data = JSON.parse(stored);
    
    if (data.history) {
      await DB.clearHistory();
      for (const item of data.history) {
        delete item.id;
        await DB.addHistory(item);
      }
    }
    
    if (data.master) await DB.bulkAddMaster(data.master);
    if (data.suppliers) {
      App.suppliers = data.suppliers;
      await DB.setSetting('suppliers', data.suppliers);
    }
    if (data.settings) {
      App.settings = { ...App.settings, ...data.settings };
    }
    
    return { itemCount: data.history?.length || 0 };
  }
};

// ============================================
// SUPPLIERS MANAGEMENT
// ============================================
const Suppliers = {
  async load() {
    App.suppliers = await DB.getSetting('suppliers', []);
  },
  async save() {
    await DB.setSetting('suppliers', App.suppliers);
  },
  add(supplier) {
    const id = Date.now().toString();
    App.suppliers.push({ id, ...supplier });
    this.save();
    return id;
  },
  update(id, data) {
    const idx = App.suppliers.findIndex(s => s.id === id);
    if (idx !== -1) {
      App.suppliers[idx] = { ...App.suppliers[idx], ...data };
      this.save();
    }
  },
  delete(id) {
    App.suppliers = App.suppliers.filter(s => s.id !== id);
    this.save();
  },
  get(id) { return App.suppliers.find(s => s.id === id); },
  getAll() { return App.suppliers; }
};

// ============================================
// GS1 BARCODE PARSER
// ============================================
const GS1 = {
  FNC1_CHARS: ['\u001d', '\u001e', '\u001c', '~'],
  PREFIXES: [']C1', ']e0', ']E0', ']d2', ']Q3', ']J1', ']I1'],

  parse(code) {
    const result = {
      raw: code || '',
      gtin: '',
      expiry: '',
      expiryISO: '',
      expiryDisplay: '',
      batch: '',
      serial: '',
      qty: 1,
      isGS1: false
    };

    if (!code || typeof code !== 'string') return result;
    code = code.trim().replace(/[\r\n\t]/g, '');
    
    for (const prefix of this.PREFIXES) {
      if (code.startsWith(prefix)) {
        code = code.substring(prefix.length);
        break;
      }
    }
    
    for (const char of this.FNC1_CHARS) {
      code = code.split(char).join('\u001d');
    }
    code = code.replace(/\[FNC1\]|<GS>|\{GS\}/gi, '\u001d');

    if (this.isGS1Format(code)) {
      result.isGS1 = true;
      this.parseGS1(code, result);
    } else {
      this.parseSimple(code, result);
    }
    
    if (result.gtin) result.gtin = this.normalizeGTIN(result.gtin);
    return result;
  },

  isGS1Format(code) {
    if (code.includes('\u001d')) return true;
    if (/\(\d{2,4}\)/.test(code)) return true;
    if (/^(01|02|10|11|17|21)\d/.test(code) && code.length > 16) return true;
    return false;
  },

  parseGS1(code, result) {
    const GS = '\u001d';
    
    if (code.includes('(')) {
      const gtinMatch = code.match(/\(01\)(\d{14})/);
      if (gtinMatch) result.gtin = gtinMatch[1];
      
      const expiryMatch = code.match(/\(17\)(\d{6})/) || code.match(/\(15\)(\d{6})/);
      if (expiryMatch) this.parseExpiryDate(expiryMatch[1], result);
      
      const batchMatch = code.match(/\(10\)([^\(]+)/);
      if (batchMatch) result.batch = batchMatch[1].trim().substring(0, 20);
      
      return;
    }
    
    let pos = 0;
    const len = code.length;
    
    while (pos < len) {
      if (code[pos] === GS) { pos++; continue; }
      const ai2 = code.substring(pos, pos + 2);
      
      switch (ai2) {
        case '01':
        case '02':
          result.gtin = code.substring(pos + 2, pos + 16);
          pos += 16;
          break;
        case '17':
        case '15':
          this.parseExpiryDate(code.substring(pos + 2, pos + 8), result);
          pos += 8;
          break;
        case '11':
        case '12':
        case '13':
          pos += 8;
          break;
        case '10':
          pos += 2;
          let batch = '';
          while (pos < len && code[pos] !== GS) batch += code[pos++];
          result.batch = batch.substring(0, 20);
          break;
        case '21':
          pos += 2;
          while (pos < len && code[pos] !== GS) pos++;
          break;
        default:
          pos++;
      }
    }
  },

  parseSimple(code, result) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8 && digits.length <= 14) result.gtin = digits;
  },

  parseExpiryDate(yymmdd, result) {
    if (!yymmdd || yymmdd.length !== 6) return;
    const yy = parseInt(yymmdd.substring(0, 2), 10);
    const mm = parseInt(yymmdd.substring(2, 4), 10);
    let dd = parseInt(yymmdd.substring(4, 6), 10);
    if (isNaN(yy) || isNaN(mm) || isNaN(dd) || mm < 1 || mm > 12) return;
    
    const year = yy >= 51 ? 1900 + yy : 2000 + yy;
    if (dd === 0) dd = new Date(year, mm, 0).getDate();
    
    result.expiry = yymmdd;
    result.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    result.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
  },

  normalizeGTIN(gtin) {
    if (!gtin) return '';
    let clean = gtin.replace(/\D/g, '');
    while (clean.length > 14 && clean.startsWith('0')) clean = clean.substring(1);
    if (clean.length > 14) clean = clean.substring(0, 14);
    return clean.padStart(14, '0');
  },

  generateVariants(gtin) {
    if (!gtin) return [];
    const clean = this.normalizeGTIN(gtin);
    if (!clean || clean.length < 8) return [];
    
    const variants = new Set();
    variants.add(clean);
    const gtin14 = clean.padStart(14, '0');
    variants.add(gtin14);
    if (gtin14.startsWith('0')) variants.add(gtin14.substring(1));
    if (gtin14.startsWith('00')) variants.add(gtin14.substring(2));
    if (clean.length >= 13) variants.add(clean.slice(-13));
    if (clean.length >= 12) variants.add(clean.slice(-12));
    if (clean.length >= 8) variants.add(clean.slice(-8));
    const noLeadingZeros = clean.replace(/^0+/, '');
    if (noLeadingZeros.length >= 8) variants.add(noLeadingZeros);
    
    return Array.from(variants);
  },

  getStatus(expiryISO) {
    if (!expiryISO) return 'unknown';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const expiry = new Date(expiryISO); expiry.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return 'expired';
    if (diffDays <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
    return 'ok';
  },

  getDaysUntil(expiryISO) {
    if (!expiryISO) return Infinity;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const expiry = new Date(expiryISO); expiry.setHours(0, 0, 0, 0);
    return Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
  },

  // Convert Excel serial date to ISO
  excelDateToISO(serial) {
    if (!serial || isNaN(serial)) return '';
    const utc_days = Math.floor(serial - 25569);
    const date = new Date(utc_days * 86400 * 1000);
    return date.toISOString().split('T')[0];
  }
};

// ============================================
// PRODUCT MATCHING
// ============================================
const Matcher = {
  buildIndex(masterData) {
    App.masterIndex.clear();
    App.masterRMS.clear();
    App.masterVariants.clear();
    App.masterFull.clear();
    
    for (const item of masterData) {
      const barcode = String(item.barcode || '').trim().replace(/\D/g, '');
      if (!barcode || barcode.length < 8) continue;
      
      // Store full product details
      const product = {
        barcode: barcode,
        name: item.name || item.description || '',
        rms: item.rms || item.rmsId || '',
        alshayaCode: item.alshayaCode || item.newAlshayaCode || '',
        brand: item.brand || '',
        supplier: item.supplier || item.supplierName || '',
        conceptGroup: item.conceptGroup || '',
        returnPolicy: item.returnPolicy || '',
        keyBrands: item.keyBrands || '',
        status: item.status || 'Active'
      };
      
      App.masterFull.set(barcode, product);
      App.masterIndex.set(barcode, product);
      
      // Generate variants
      const variants = GS1.generateVariants(barcode);
      for (const v of variants) {
        if (!App.masterVariants.has(v)) App.masterVariants.set(v, product);
      }
      
      // Index by RMS
      if (product.rms) {
        App.masterRMS.set(product.rms, product);
        App.masterRMS.set(product.rms.replace(/\D/g, ''), product);
      }
    }
    
    console.log(`📋 Index: ${App.masterIndex.size} products`);
  },

  find(code) {
    if (!code) return null;
    const clean = code.replace(/\D/g, '');
    if (clean.length < 4) return null;
    
    // Try variants
    const variants = GS1.generateVariants(clean);
    for (const v of variants) {
      if (App.masterVariants.has(v)) {
        return { ...App.masterVariants.get(v), matchType: 'GTIN' };
      }
    }
    
    // Try RMS
    if (App.masterRMS.has(clean)) return { ...App.masterRMS.get(clean), matchType: 'RMS' };
    if (App.masterRMS.has(code)) return { ...App.masterRMS.get(code), matchType: 'RMS' };
    
    // Try direct
    if (App.masterIndex.has(clean)) return { ...App.masterIndex.get(clean), matchType: 'DIRECT' };
    
    return null;
  }
};

// ============================================
// API LOOKUPS
// ============================================
const API = {
  async lookup(gtin) {
    if (!App.settings.apiEnabled || !navigator.onLine) return null;
    const clean = GS1.normalizeGTIN(gtin);
    const gtins = [clean, clean.slice(1), clean.slice(2)].filter(g => g.length >= 8);
    
    for (const g of gtins) {
      let result = await this.openFoodFacts(g);
      if (result) return result;
    }
    return null;
  },

  async openFoodFacts(gtin) {
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.status === 1 && data.product?.product_name) {
        return { name: data.product.product_name, brand: data.product.brands || '', source: 'API' };
      }
    } catch (e) {}
    return null;
  }
};

// ============================================
// DATABASE LAYER
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { App.db = request.result; resolve(); };
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        if (!db.objectStoreNames.contains('history')) {
          const store = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          store.createIndex('gtin', 'gtin', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('master')) {
          const store = db.createObjectStore('master', { keyPath: 'barcode' });
          store.createIndex('name', 'name', { unique: false });
          store.createIndex('rms', 'rms', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  },

  async _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction(store, mode);
      const s = tx.objectStore(store);
      const result = fn(s);
      if (result && result.onsuccess !== undefined) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  },

  async addHistory(item) { item.timestamp = item.timestamp || Date.now(); return this._tx('history', 'readwrite', s => s.add(item)); },
  async updateHistory(item) { return this._tx('history', 'readwrite', s => s.put(item)); },
  async getHistory(id) { return this._tx('history', 'readonly', s => s.get(id)); },
  async getAllHistory() { return this._tx('history', 'readonly', s => s.getAll()); },
  async deleteHistory(id) { return this._tx('history', 'readwrite', s => s.delete(id)); },
  async clearHistory() { return this._tx('history', 'readwrite', s => s.clear()); },
  async addMaster(item) { return this._tx('master', 'readwrite', s => s.put(item)); },
  async getAllMaster() { return this._tx('master', 'readonly', s => s.getAll()); },
  async clearMaster() { return this._tx('master', 'readwrite', s => s.clear()); },
  
  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      let count = 0;
      for (const item of items) {
        if (item.barcode) { store.put(item); count++; }
      }
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getSetting(key, defaultValue = null) {
    try {
      const result = await this._tx('settings', 'readonly', s => s.get(key));
      return result ? result.value : defaultValue;
    } catch { return defaultValue; }
  },
  
  async setSetting(key, value) {
    return this._tx('settings', 'readwrite', s => s.put({ key, value }));
  }
};

// ============================================
// SCANNER
// ============================================
const Scanner = {
  async toggle() {
    if (App.scanner.active) await this.stop();
    else await this.start();
  },

  async start() {
    try {
      if (!App.scanner.instance) App.scanner.instance = new Html5Qrcode('reader');
      
      await App.scanner.instance.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 220, height: 160 } },
        (code) => this.onScan(code),
        () => {}
      );
      
      App.scanner.active = true;
      document.getElementById('scannerPlaceholder').classList.add('hidden');
      document.getElementById('viewfinder').classList.add('active');
      document.getElementById('btnScannerText').textContent = 'Stop Scanner';
      document.getElementById('btnScanner').classList.add('stop');
      haptic('medium');
    } catch (e) {
      console.error('Scanner error:', e);
      toast('Camera access denied', 'error');
    }
  },

  async stop() {
    if (App.scanner.instance && App.scanner.active) {
      try { await App.scanner.instance.stop(); } catch (e) {}
    }
    App.scanner.active = false;
    document.getElementById('scannerPlaceholder').classList.remove('hidden');
    document.getElementById('viewfinder').classList.remove('active');
    document.getElementById('btnScannerText').textContent = 'Start Scanner';
    document.getElementById('btnScanner').classList.remove('stop');
  },

  async onScan(code) {
    await this.stop();
    haptic('success');
    
    if (App.scanMode === 'product' && App.pendingItem) {
      await completeWithProductScan(code);
    } else {
      await processBarcode(code);
    }
  }
};

// ============================================
// BARCODE PROCESSING
// ============================================
async function processBarcode(code, options = {}) {
  const { silent = false, skipRefresh = false } = options;
  if (!code || typeof code !== 'string') return null;
  code = code.trim();
  if (!code) return null;
  
  const parsed = GS1.parse(code);
  
  if (!parsed.gtin) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8) parsed.gtin = GS1.normalizeGTIN(digits);
    else { if (!silent) toast('Invalid barcode', 'error'); return null; }
  }
  
  let product = Matcher.find(parsed.gtin);
  
  if (product && product.name) {
    return await saveItem(parsed, product, options);
  }
  
  if (App.settings.apiEnabled && navigator.onLine) {
    toast('Looking up...', 'info');
    const apiResult = await API.lookup(parsed.gtin);
    if (apiResult) {
      product = { name: apiResult.name, brand: apiResult.brand, rms: '', matchType: 'API' };
      return await saveItem(parsed, product, options);
    }
  }
  
  // Multi-scan mode
  App.pendingItem = { ...parsed, timestamp: Date.now() };
  App.scanMode = 'product';
  showProductScanPrompt(parsed);
  haptic('medium');
  return null;
}

async function completeWithProductScan(code) {
  const productParsed = GS1.parse(code);
  const productCode = productParsed.gtin || code.replace(/\D/g, '');
  
  let product = Matcher.find(productCode) || Matcher.find(code);
  
  if (!product && App.settings.apiEnabled && navigator.onLine) {
    const apiResult = await API.lookup(productCode);
    if (apiResult) product = { name: apiResult.name, brand: apiResult.brand, rms: '', matchType: 'API' };
  }
  
  if (!product || !product.name) {
    hideProductScanPrompt();
    showEditModal(App.pendingItem, productCode);
    return;
  }
  
  const pending = App.pendingItem;
  clearPendingItem();
  await saveItem(pending, product);
}

async function saveItem(parsed, product, options = {}) {
  const { silent = false, skipRefresh = false } = options;
  
  const entry = {
    raw: parsed.raw,
    gtin: parsed.gtin,
    scannedBarcode: parsed.raw.replace(/\D/g, '').substring(0, 13), // 13 digit barcode
    name: product.name || 'Unknown Product',
    rms: product.rms || '',
    alshayaCode: product.alshayaCode || '',
    brand: product.brand || '',
    supplier: product.supplier || '',
    conceptGroup: product.conceptGroup || '',
    returnPolicy: product.returnPolicy || '',
    keyBrands: product.keyBrands || '',
    status: product.status || '',
    matchType: product.matchType || 'UNKNOWN',
    expiryISO: parsed.expiryISO,
    expiryDisplay: parsed.expiryDisplay,
    batch: parsed.batch,
    qty: parsed.qty || 1,
    category: 'medicine',
    supplierId: '',
    remarks: '',
    storeName: App.settings.storeName,
    timestamp: Date.now()
  };
  
  const id = await DB.addHistory(entry);
  entry.id = id;
  
  if (!silent) {
    toast(`Added: ${entry.name}`, 'success');
    haptic('success');
  }
  
  if (!skipRefresh) await refreshUI();
  document.getElementById('manualInput').value = '';
  return entry;
}

async function adjustQty(id, delta) {
  const item = await DB.getHistory(id);
  if (!item) return;
  item.qty = Math.max(1, (item.qty || 1) + delta);
  await DB.updateHistory(item);
  haptic('light');
  await refreshUI();
}

// ============================================
// PRODUCT SCAN PROMPT
// ============================================
function showProductScanPrompt(parsed) {
  let prompt = document.getElementById('productScanPrompt');
  if (!prompt) {
    prompt = document.createElement('div');
    prompt.id = 'productScanPrompt';
    prompt.className = 'modal-bg';
    prompt.innerHTML = `
      <div class="modal">
        <div class="modal-head" style="background: linear-gradient(135deg, #FFA94D 0%, #FF6B6B 100%);">
          <h3>⚠️ Product Not Found</h3>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">GTIN</label>
            <div class="mono" id="promptGtin" style="padding: 10px; background: var(--bg-main); border-radius: 8px;">-</div>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div class="form-group">
              <label class="form-label">Expiry</label>
              <div id="promptExpiry" style="padding: 10px; background: var(--bg-main); border-radius: 8px;">-</div>
            </div>
            <div class="form-group">
              <label class="form-label">Batch</label>
              <div class="mono" id="promptBatch" style="padding: 10px; background: var(--bg-main); border-radius: 8px;">-</div>
            </div>
          </div>
          <p style="text-align: center; font-size: 0.85rem; color: var(--text-medium); margin: 16px 0;">
            Scan <strong>product barcode</strong> or <strong>RMS code</strong>
          </p>
          <div class="modal-actions">
            <button class="btn btn-ghost" onclick="skipProductLookup()">Skip</button>
            <button class="btn btn-ghost" onclick="hideProductScanPrompt(); showEditModal(App.pendingItem);">Manual</button>
            <button class="btn btn-primary" onclick="hideProductScanPrompt(); Scanner.start();">📷 Scan</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(prompt);
  }
  
  document.getElementById('promptGtin').textContent = parsed.gtin || '-';
  document.getElementById('promptExpiry').textContent = parsed.expiryDisplay || '-';
  document.getElementById('promptBatch').textContent = parsed.batch || '-';
  prompt.classList.add('show');
}

function hideProductScanPrompt() {
  document.getElementById('productScanPrompt')?.classList.remove('show');
}

function clearPendingItem() {
  App.pendingItem = null;
  App.scanMode = 'normal';
  hideProductScanPrompt();
}

async function skipProductLookup() {
  if (!App.pendingItem) return;
  const parsed = App.pendingItem;
  clearPendingItem();
  await saveItem(parsed, { name: 'Unknown Product', rms: '', matchType: 'SKIPPED' });
}

// ============================================
// ENHANCED CSV EXPORT
// ============================================
async function exportCSV() {
  const history = await DB.getAllHistory();
  if (history.length === 0) { toast('No data to export', 'warning'); return; }
  
  // Headers matching user's template
  const headers = [
    'STORE NAME',
    'RMS CODE',
    'BARCODE',
    'DESCRIPTION',
    'BATCH NO',
    'EXPIRY DATE',
    'CONCEPT GROUP',
    'BRAND',
    'RETURN POLICY',
    'KEY BRANDS',
    'SUPPLIER NAME',
    'STATUS',
    'QTY',
    'REMARKS'
  ];
  
  const rows = history.map(h => {
    // Format expiry as Excel serial if available
    let expiryValue = '';
    if (h.expiryISO) {
      const d = new Date(h.expiryISO);
      // Excel serial date (days since 1900-01-01)
      expiryValue = Math.floor((d.getTime() - new Date(1899, 11, 30).getTime()) / 86400000);
    }
    
    return [
      h.storeName || App.settings.storeName || '',
      h.rms || '',
      h.scannedBarcode || h.gtin?.slice(-13) || '',
      h.name || '',
      h.batch || '',
      expiryValue || '',
      h.conceptGroup || '',
      h.brand || '',
      h.returnPolicy || '',
      h.keyBrands || '',
      h.supplier || '',
      h.status || GS1.getStatus(h.expiryISO).toUpperCase(),
      h.qty || 1,
      h.remarks || ''
    ];
  });
  
  // Create CSV
  let csv = headers.join('\t') + '\n';
  for (const row of rows) {
    csv += row.map(c => `"${String(c).replace(/"/g, '""')}"`).join('\t') + '\n';
  }
  
  downloadFile(csv, `expiry-report-${formatDateFile(new Date())}.csv`, 'text/csv');
  toast('Exported', 'success');
}

// Export in exact format matching user template
async function exportExcel() {
  const history = await DB.getAllHistory();
  if (history.length === 0) { toast('No data', 'warning'); return; }
  
  // Create TSV format for easy Excel paste
  const headers = [
    'BARCODE', 'RMS ID', 'ALSHAYA CODE', 'NEW ALSHAYA CODE', 'DESCRIPTION', 'BRAND', 'SUPPLIER',
    'Scan her Barcode', 'RMS', 'ALSHAYA CODE/ PART NUMBER', 'DESCRIPTION', 'BRAND', 'SUPPLIER NAME',
    'QTY', 'EXPIRY DATE', 'BATCH NO'
  ];
  
  const rows = history.map(h => {
    let expirySerial = '';
    if (h.expiryISO) {
      const d = new Date(h.expiryISO);
      expirySerial = Math.floor((d.getTime() - new Date(1899, 11, 30).getTime()) / 86400000);
    }
    
    return [
      h.gtin?.slice(-13) || '',  // BARCODE (from master)
      h.rms || '',               // RMS ID (from master)
      h.alshayaCode || '',       // ALSHAYA CODE (from master)
      h.alshayaCode || '',       // NEW ALSHAYA CODE
      h.name || '',              // DESCRIPTION (from master)
      h.brand || '',             // BRAND (from master)
      h.supplier || '',          // SUPPLIER (from master)
      h.scannedBarcode || '',    // Scan her Barcode (scanned)
      h.rms || '',               // RMS (pulled)
      h.alshayaCode || '',       // ALSHAYA CODE/ PART NUMBER
      h.name || '',              // DESCRIPTION (pulled)
      h.brand || '',             // BRAND (pulled)
      h.supplier || '',          // SUPPLIER NAME (pulled)
      h.qty || 1,                // QTY
      expirySerial || '',        // EXPIRY DATE
      h.batch || ''              // BATCH NO
    ];
  });
  
  let tsv = headers.join('\t') + '\n';
  for (const row of rows) {
    tsv += row.join('\t') + '\n';
  }
  
  downloadFile(tsv, `expiry-export-${formatDateFile(new Date())}.tsv`, 'text/tab-separated-values');
  toast('Exported for Excel', 'success');
}

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  await Promise.all([
    refreshRecentScans(),
    refreshHistoryList(),
    refreshMasterCount(),
    refreshHistoryCount(),
    refreshSuppliersList()
  ]);
}

async function refreshRecentScans() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  const recent = history.slice(0, 5);
  const container = document.getElementById('recentScans');
  const empty = document.getElementById('emptyRecent');
  
  if (recent.length === 0) {
    container.innerHTML = '';
    container.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }
  
  empty.classList.add('hidden');
  container.innerHTML = recent.map(item => renderHistoryItem(item)).join('');
}

async function refreshHistoryList() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  
  let filtered = history;
  
  if (App.filter !== 'all') {
    if (App.categories.find(c => c.id === App.filter)) {
      filtered = history.filter(h => h.category === App.filter);
    } else {
      filtered = history.filter(h => GS1.getStatus(h.expiryISO) === App.filter);
    }
  }
  
  if (App.search) {
    const q = App.search.toLowerCase();
    filtered = filtered.filter(h =>
      (h.name && h.name.toLowerCase().includes(q)) ||
      (h.gtin && h.gtin.includes(q)) ||
      (h.batch && h.batch.toLowerCase().includes(q)) ||
      (h.rms && h.rms.includes(q)) ||
      (h.brand && h.brand.toLowerCase().includes(q))
    );
  }
  
  const container = document.getElementById('historyList');
  const empty = document.getElementById('emptyHistory');
  
  if (filtered.length === 0) {
    container.innerHTML = '';
    container.appendChild(empty);
    empty.classList.remove('hidden');
    return;
  }
  
  empty.classList.add('hidden');
  container.innerHTML = filtered.map(item => renderHistoryItem(item, true)).join('');
}

function renderHistoryItem(item, showActions = false) {
  const status = GS1.getStatus(item.expiryISO);
  const days = GS1.getDaysUntil(item.expiryISO);
  const category = App.categories.find(c => c.id === item.category) || App.categories[5];
  
  let badgeClass = 'badge-ok';
  let badgeText = 'OK';
  
  if (status === 'expired') { badgeClass = 'badge-expired'; badgeText = 'EXPIRED'; }
  else if (status === 'expiring') { badgeClass = 'badge-expiring'; badgeText = `${days}d`; }
  else if (days !== Infinity) { badgeText = `${days}d`; }
  
  return `
    <div class="history-item ${status}" onclick="editItem(${item.id})">
      <div class="item-icon" style="background: linear-gradient(135deg, ${category.color} 0%, ${category.color}99 100%);">
        <span style="font-size: 1.2rem;">${category.icon}</span>
      </div>
      <div class="item-info">
        <div class="item-name">${escapeHtml(item.name || 'Unknown')}</div>
        <div class="item-details">
          ${item.expiryDisplay || 'No expiry'} • ${item.batch || 'No batch'}
          ${item.brand ? '• ' + escapeHtml(item.brand) : ''}
        </div>
      </div>
      <div class="item-badge ${badgeClass}">${badgeText}</div>
      <div class="qty-controls" onclick="event.stopPropagation();">
        <button class="qty-btn" onclick="adjustQty(${item.id}, -1)">−</button>
        <span class="qty-value">${item.qty || 1}</span>
        <button class="qty-btn" onclick="adjustQty(${item.id}, 1)">+</button>
      </div>
    </div>
  `;
}

async function refreshMasterCount() {
  const master = await DB.getAllMaster();
  document.getElementById('masterCount').textContent = master.length;
  Matcher.buildIndex(master);
}

async function refreshHistoryCount() {
  const history = await DB.getAllHistory();
  document.getElementById('historyCount').textContent = history.length;
}

async function refreshSuppliersList() {
  const container = document.getElementById('suppliersList');
  if (!container) return;
  
  if (App.suppliers.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 20px;">No suppliers added</p>';
    return;
  }
  
  container.innerHTML = App.suppliers.map(s => `
    <div class="supplier-item">
      <div class="supplier-info">
        <div class="supplier-name">${escapeHtml(s.name)}</div>
        <div class="supplier-details">${escapeHtml(s.phone || '')} ${s.email ? '• ' + escapeHtml(s.email) : ''}</div>
      </div>
      <button class="btn-icon" onclick="editSupplier('${s.id}')">✏️</button>
      <button class="btn-icon" onclick="deleteSupplier('${s.id}')">🗑️</button>
    </div>
  `).join('');
}

// ============================================
// MODALS
// ============================================
function showEditModal(item, productCode = '') {
  App.editingId = item?.id || null;
  
  document.getElementById('editName').value = item?.name || '';
  document.getElementById('editQty').value = item?.qty || 1;
  document.getElementById('editExpiry').value = item?.expiryISO || '';
  document.getElementById('editBatch').value = item?.batch || '';
  document.getElementById('editCategory').value = item?.category || 'medicine';
  document.getElementById('editBrand').value = item?.brand || '';
  document.getElementById('editRms').value = item?.rms || '';
  document.getElementById('editRemarks').value = item?.remarks || '';
  
  const supplierSelect = document.getElementById('editSupplier');
  supplierSelect.innerHTML = '<option value="">Select supplier...</option>' +
    App.suppliers.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  
  document.getElementById('editModal').classList.add('show');
}

async function saveEdit() {
  const name = document.getElementById('editName').value.trim();
  const qty = parseInt(document.getElementById('editQty').value) || 1;
  const expiryISO = document.getElementById('editExpiry').value;
  const batch = document.getElementById('editBatch').value.trim();
  const category = document.getElementById('editCategory').value;
  const brand = document.getElementById('editBrand').value.trim();
  const rms = document.getElementById('editRms').value.trim();
  const remarks = document.getElementById('editRemarks').value.trim();
  
  if (!name) { toast('Enter product name', 'warning'); return; }
  
  const expiryDisplay = expiryISO ? formatDateDisplay(expiryISO) : '';
  
  if (App.editingId) {
    const item = await DB.getHistory(App.editingId);
    if (item) {
      Object.assign(item, { name, qty, expiryISO, expiryDisplay, batch, category, brand, rms, remarks });
      await DB.updateHistory(item);
      if (item.gtin) await DB.addMaster({ barcode: item.gtin, name, rms, brand });
    }
  } else if (App.pendingItem) {
    Object.assign(App.pendingItem, { expiryISO, expiryDisplay, batch, qty });
    await saveItem(App.pendingItem, { name, rms, brand, matchType: 'MANUAL' });
    clearPendingItem();
  }
  
  closeEditModal();
  await refreshUI();
  toast('Saved', 'success');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('show');
  App.editingId = null;
}

async function editItem(id) {
  const item = await DB.getHistory(id);
  if (item) showEditModal(item);
}

// Supplier modal
function showSupplierModal(supplier = null) {
  document.getElementById('supplierName').value = supplier?.name || '';
  document.getElementById('supplierPhone').value = supplier?.phone || '';
  document.getElementById('supplierEmail').value = supplier?.email || '';
  document.getElementById('supplierNotes').value = supplier?.notes || '';
  document.getElementById('supplierModal').dataset.editId = supplier?.id || '';
  document.getElementById('supplierModal').classList.add('show');
}

async function saveSupplier() {
  const name = document.getElementById('supplierName').value.trim();
  if (!name) { toast('Enter supplier name', 'warning'); return; }
  
  const data = {
    name,
    phone: document.getElementById('supplierPhone').value.trim(),
    email: document.getElementById('supplierEmail').value.trim(),
    notes: document.getElementById('supplierNotes').value.trim()
  };
  
  const editId = document.getElementById('supplierModal').dataset.editId;
  if (editId) Suppliers.update(editId, data);
  else Suppliers.add(data);
  
  closeSupplierModal();
  await refreshSuppliersList();
  toast('Supplier saved', 'success');
}

function closeSupplierModal() { document.getElementById('supplierModal').classList.remove('show'); }
function editSupplier(id) { const s = Suppliers.get(id); if (s) showSupplierModal(s); }
function deleteSupplier(id) { if (confirm('Delete?')) { Suppliers.delete(id); refreshSuppliersList(); toast('Deleted', 'success'); } }

// Cloud modal
function showCloudModal() { document.getElementById('cloudModal').classList.add('show'); }
function closeCloudModal() { document.getElementById('cloudModal').classList.remove('show'); }
function generateBackupCode() { document.getElementById('backupCode').value = CloudSync.generateCode(); }

async function cloudSave() {
  const code = document.getElementById('backupCode').value.trim();
  if (!code) { toast('Enter code', 'warning'); return; }
  try {
    const r = await CloudSync.save(code);
    toast(`Saved ${r.itemCount} items`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function cloudLoad() {
  const code = document.getElementById('backupCode').value.trim();
  if (!code) { toast('Enter code', 'warning'); return; }
  try {
    const r = await CloudSync.load(code);
    await refreshUI();
    toast(`Loaded ${r.itemCount} items`, 'success');
    closeCloudModal();
  } catch (e) { toast(e.message, 'error'); }
}

// Store name modal
function showStoreModal() {
  document.getElementById('storeNameInput').value = App.settings.storeName || '';
  document.getElementById('storeModal').classList.add('show');
}

function saveStoreName() {
  const name = document.getElementById('storeNameInput').value.trim();
  App.settings.storeName = name || CONFIG.STORE_NAME;
  DB.setSetting('storeName', App.settings.storeName);
  document.getElementById('storeModal').classList.remove('show');
  toast('Store name saved', 'success');
}

// ============================================
// MASTER DATA UPLOAD
// ============================================
async function uploadMasterFile(file) {
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    if (lines.length < 2) { toast('Invalid file', 'error'); return; }
    
    const header = lines[0].toLowerCase();
    const delim = header.includes('\t') ? '\t' : ',';
    const cols = header.split(delim).map(c => c.trim().replace(/['"]/g, '').toLowerCase());
    
    // Map columns
    const colMap = {
      barcode: cols.findIndex(c => ['barcode', 'gtin', 'ean', 'upc', 'code'].includes(c)),
      name: cols.findIndex(c => ['name', 'description', 'product'].includes(c)),
      rms: cols.findIndex(c => ['rms', 'rms id', 'rms_id', 'rmscode'].includes(c)),
      alshayaCode: cols.findIndex(c => ['alshaya code', 'alshaya_code', 'alshayacode', 'new alshaya code'].includes(c)),
      brand: cols.findIndex(c => ['brand'].includes(c)),
      supplier: cols.findIndex(c => ['supplier', 'supplier name', 'supplier_name'].includes(c)),
      conceptGroup: cols.findIndex(c => ['concept group', 'concept_group', 'conceptgroup'].includes(c)),
      returnPolicy: cols.findIndex(c => ['return policy', 'return_policy', 'returnpolicy'].includes(c)),
      keyBrands: cols.findIndex(c => ['key brands', 'key_brands', 'keybrands'].includes(c)),
      status: cols.findIndex(c => ['status'].includes(c))
    };
    
    if (colMap.barcode === -1) { toast('No barcode column', 'error'); return; }
    
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/^["']|["']$/g, ''));
      const barcode = (row[colMap.barcode] || '').replace(/\D/g, '');
      
      if (barcode && barcode.length >= 8) {
        items.push({
          barcode,
          name: colMap.name >= 0 ? row[colMap.name] : '',
          rms: colMap.rms >= 0 ? row[colMap.rms] : '',
          alshayaCode: colMap.alshayaCode >= 0 ? row[colMap.alshayaCode] : '',
          brand: colMap.brand >= 0 ? row[colMap.brand] : '',
          supplier: colMap.supplier >= 0 ? row[colMap.supplier] : '',
          conceptGroup: colMap.conceptGroup >= 0 ? row[colMap.conceptGroup] : '',
          returnPolicy: colMap.returnPolicy >= 0 ? row[colMap.returnPolicy] : '',
          keyBrands: colMap.keyBrands >= 0 ? row[colMap.keyBrands] : '',
          status: colMap.status >= 0 ? row[colMap.status] : 'Active'
        });
      }
    }
    
    const count = await DB.bulkAddMaster(items);
    await refreshMasterCount();
    toast(`Uploaded ${count} products`, 'success');
    document.getElementById('lastUpdated').textContent = 'Now';
  } catch (e) {
    console.error(e);
    toast('Upload failed', 'error');
  }
}

// ============================================
// BULK PROCESSING
// ============================================
async function processBulk() {
  const text = document.getElementById('bulkInput').value.trim();
  if (!text) { toast('No barcodes', 'warning'); return; }
  
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l);
  let total = 0, valid = 0, matched = 0;
  
  for (const line of lines) {
    total++;
    const parsed = GS1.parse(line);
    if (parsed.gtin) {
      valid++;
      let product = Matcher.find(parsed.gtin);
      if (!product && App.settings.apiEnabled) {
        const api = await API.lookup(parsed.gtin);
        if (api) product = { name: api.name, brand: api.brand, matchType: 'API' };
      }
      if (!product) product = { name: 'Unknown', matchType: 'NONE' };
      else matched++;
      await saveItem(parsed, product, { silent: true, skipRefresh: true });
    }
  }
  
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statValid').textContent = valid;
  document.getElementById('statMatched').textContent = matched;
  
  await refreshUI();
  toast(`Processed ${valid}/${total}`, 'success');
  document.getElementById('bulkInput').value = '';
}

// ============================================
// UTILITIES
// ============================================
function toast(msg, type = 'info') {
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="toast-icon">${{success:'✓',error:'✕',warning:'⚠',info:'ℹ'}[type]||'ℹ'}</div><span class="toast-msg">${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function haptic(type = 'light') {
  if (!App.settings.hapticEnabled || !navigator.vibrate) return;
  navigator.vibrate({light:10,medium:30,success:[30,50,30],error:[100,50,100]}[type] || 10);
}

function escapeHtml(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
function formatDateDisplay(iso) { if (!iso) return ''; const d = new Date(iso); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; }
function formatDateFile(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function downloadFile(content, filename, mime) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([content], {type: mime})); a.download = filename; a.click(); }

// ============================================
// NAVIGATION
// ============================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${pageId}`)?.classList.add('active');
  document.querySelector(`.nav-btn[data-page="${pageId}"]`)?.classList.add('active');
  if (pageId !== 'home' && App.scanner.active) Scanner.stop();
  closeSideMenu();
}

function openSideMenu() { document.getElementById('sideMenuBg').classList.add('show'); document.getElementById('sideMenu').classList.add('show'); }
function closeSideMenu() { document.getElementById('sideMenuBg').classList.remove('show'); document.getElementById('sideMenu').classList.remove('show'); }

// ============================================
// EVENT SETUP
// ============================================
function setupEvents() {
  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', () => showPage(btn.dataset.page)));
  
  // Scanner
  document.getElementById('btnScanner').addEventListener('click', () => Scanner.toggle());
  document.getElementById('scannerFrame').addEventListener('click', () => { if (!App.scanner.active) Scanner.start(); });
  
  // Manual input
  document.getElementById('manualInput').addEventListener('keypress', e => { if (e.key === 'Enter') processBarcode(document.getElementById('manualInput').value); });
  document.getElementById('btnManualAdd').addEventListener('click', () => processBarcode(document.getElementById('manualInput').value));
  
  document.getElementById('viewAllHistory').addEventListener('click', () => showPage('history'));
  document.getElementById('searchInput').addEventListener('input', e => { App.search = e.target.value; refreshHistoryList(); });
  
  document.querySelectorAll('.chip').forEach(chip => chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    App.filter = chip.dataset.filter;
    refreshHistoryList();
  }));
  
  // Bulk
  document.getElementById('btnProcessBulk').addEventListener('click', processBulk);
  document.getElementById('btnClearBulk').addEventListener('click', () => { document.getElementById('bulkInput').value = ''; });
  
  // Master upload
  document.getElementById('uploadArea').addEventListener('click', () => document.getElementById('masterFileInput').click());
  document.getElementById('masterFileInput').addEventListener('change', e => { if (e.target.files[0]) { uploadMasterFile(e.target.files[0]); e.target.value = ''; } });
  
  // Toggles
  document.getElementById('toggleApi')?.addEventListener('click', function() { this.classList.toggle('on'); App.settings.apiEnabled = this.classList.contains('on'); DB.setSetting('apiEnabled', App.settings.apiEnabled); });
  document.getElementById('toggleHaptic')?.addEventListener('click', function() { this.classList.toggle('on'); App.settings.hapticEnabled = this.classList.contains('on'); });
  document.getElementById('toggleDarkMode')?.addEventListener('click', () => DarkMode.toggle());
  
  // Export
  document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
  document.getElementById('btnExportExcel')?.addEventListener('click', exportExcel);
  document.getElementById('menuExport').addEventListener('click', () => { closeSideMenu(); exportCSV(); });
  
  // Clear
  document.getElementById('btnClearAll').addEventListener('click', async () => { if (confirm('Clear all?')) { await DB.clearHistory(); await refreshUI(); toast('Cleared', 'success'); } });
  document.getElementById('menuClear').addEventListener('click', async () => { closeSideMenu(); if (confirm('Clear?')) { await DB.clearHistory(); await refreshUI(); } });
  
  // Side menu
  document.getElementById('btnMenu').addEventListener('click', openSideMenu);
  document.getElementById('sideMenuBg').addEventListener('click', closeSideMenu);
  document.getElementById('menuAbout').addEventListener('click', () => { closeSideMenu(); alert(`GS1 Tracker v${CONFIG.VERSION}\nBy VYSAKH`); });
  document.getElementById('menuCloud')?.addEventListener('click', () => { closeSideMenu(); showCloudModal(); });
  document.getElementById('menuStore')?.addEventListener('click', () => { closeSideMenu(); showStoreModal(); });
  
  // Modals
  document.getElementById('btnCancelEdit').addEventListener('click', closeEditModal);
  document.getElementById('btnSaveEdit').addEventListener('click', saveEdit);
  document.getElementById('editModal').addEventListener('click', e => { if (e.target.id === 'editModal') closeEditModal(); });
  
  document.getElementById('btnAddSupplier')?.addEventListener('click', () => showSupplierModal());
  document.getElementById('btnCancelSupplier')?.addEventListener('click', closeSupplierModal);
  document.getElementById('btnSaveSupplier')?.addEventListener('click', saveSupplier);
  
  document.getElementById('btnCloudSync')?.addEventListener('click', showCloudModal);
  document.getElementById('btnCloseCloud')?.addEventListener('click', closeCloudModal);
  document.getElementById('btnGenerateCode')?.addEventListener('click', generateBackupCode);
  document.getElementById('btnCloudSave')?.addEventListener('click', cloudSave);
  document.getElementById('btnCloudLoad')?.addEventListener('click', cloudLoad);
  
  document.getElementById('btnSaveStore')?.addEventListener('click', saveStoreName);
  
  window.addEventListener('online', () => document.getElementById('offlineTag').classList.remove('show'));
  window.addEventListener('offline', () => document.getElementById('offlineTag').classList.add('show'));
}

// ============================================
// INITIALIZATION
// ============================================
async function init() {
  console.log('🚀 GS1 Tracker v' + CONFIG.VERSION);
  
  try {
    await DB.init();
    
    App.settings.apiEnabled = await DB.getSetting('apiEnabled', true);
    App.settings.hapticEnabled = await DB.getSetting('hapticEnabled', true);
    App.settings.storeName = await DB.getSetting('storeName', CONFIG.STORE_NAME);
    
    document.getElementById('toggleApi')?.classList.toggle('on', App.settings.apiEnabled);
    document.getElementById('toggleHaptic')?.classList.toggle('on', App.settings.hapticEnabled);
    
    DarkMode.init();
    await Suppliers.load();
    await refreshMasterCount();
    await refreshUI();
    setupEvents();
    
    if (!navigator.onLine) document.getElementById('offlineTag').classList.add('show');
    console.log('✅ Ready');
  } catch (e) {
    console.error(e);
    toast('Init failed', 'error');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => {});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
