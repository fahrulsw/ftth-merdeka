const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data', 'database.json');
const JWT_SECRET = process.env.JWT_SECRET || 'merdeka-secret-key-2025';
const JWT_EXPIRES = '8h';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===================== DATABASE =====================

async function initDB() {
  await fs.ensureDir(path.join(__dirname, 'data'));
  if (!await fs.pathExists(DATA_FILE)) {
    // Default admin user
    const hashedPassword = await bcrypt.hash('admin123', 10);
    const initialData = {
      users: [
        {
          id: uuidv4(),
          username: 'admin',
          nama: 'Administrator',
          password: hashedPassword,
          role: 'admin',
          aktif: true,
          created_at: new Date().toISOString()
        }
      ],
      odc: [],
      odp: [],
      pelanggan: []
    };
    await fs.writeJson(DATA_FILE, initialData, { spaces: 2 });
    console.log('Database initialized');
    console.log('Default login: admin / admin123');
  } else {
    // Migrate: tambah array users jika belum ada
    const db = await fs.readJson(DATA_FILE);
    if (!db.users) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      db.users = [
        {
          id: uuidv4(),
          username: 'admin',
          nama: 'Administrator',
          password: hashedPassword,
          role: 'admin',
          aktif: true,
          created_at: new Date().toISOString()
        }
      ];
      await fs.writeJson(DATA_FILE, db, { spaces: 2 });
      console.log('Users migrated. Default login: admin / admin123');
    }
  }
}

async function readDB() {
  return await fs.readJson(DATA_FILE);
}

async function writeDB(data) {
  await fs.writeJson(DATA_FILE, data, { spaces: 2 });
}

// ===================== AUTH MIDDLEWARE =====================

function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Token tidak ditemukan' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token tidak valid atau kadaluarsa' });
  }
}

// Middleware: hanya admin & noc yang bisa CRUD
function crudMiddleware(req, res, next) {
  if (req.user.role === 'teknisi') {
    return res.status(403).json({ success: false, message: 'Akses ditolak: role Teknisi tidak dapat melakukan perubahan data' });
  }
  next();
}

// Middleware: hanya admin yang bisa kelola user
function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Akses ditolak: hanya Admin yang dapat mengelola pengguna' });
  }
  next();
}

// ===================== AUTH ROUTES =====================

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username dan password wajib diisi' });
    }
    const db = await readDB();
    const user = db.users.find(u => u.username === username);
    if (!user) return res.status(401).json({ success: false, message: 'Username atau password salah' });
    if (!user.aktif) return res.status(403).json({ success: false, message: 'Akun Anda telah dinonaktifkan' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ success: false, message: 'Username atau password salah' });

    const token = jwt.sign(
      { id: user.id, username: user.username, nama: user.nama, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, nama: user.nama, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Verify token (cek sesi)
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Ganti password (hanya admin)
app.put('/api/auth/password', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { user_id, password_baru } = req.body;
    if (!user_id || !password_baru) {
      return res.status(400).json({ success: false, message: 'User ID dan password baru wajib diisi' });
    }
    if (password_baru.length < 6) {
      return res.status(400).json({ success: false, message: 'Password baru minimal 6 karakter' });
    }
    const db = await readDB();
    const idx = db.users.findIndex(u => u.id === user_id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    db.users[idx].password = await bcrypt.hash(password_baru, 10);
    await writeDB(db);
    res.json({ success: true, message: 'Password berhasil diubah' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== USER MANAGEMENT (Admin only) =====================

// Get all users
app.get('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const users = db.users.map(({ password, ...u }) => u); // hide password
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create user
app.post('/api/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { username, nama, password, role } = req.body;
    if (!username || !nama || !password || !role) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }
    if (!['admin', 'noc', 'teknisi'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role tidak valid' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
    }
    const db = await readDB();
    if (db.users.find(u => u.username === username)) {
      return res.status(400).json({ success: false, message: 'Username sudah digunakan' });
    }
    const newUser = {
      id: uuidv4(),
      username,
      nama,
      password: await bcrypt.hash(password, 10),
      role,
      aktif: true,
      created_at: new Date().toISOString()
    };
    db.users.push(newUser);
    await writeDB(db);
    const { password: _, ...safeUser } = newUser;
    res.status(201).json({ success: true, data: safeUser, message: 'User berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update user
app.put('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const { nama, role, aktif, password } = req.body;
    if (role && !['admin', 'noc', 'teknisi'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role tidak valid' });
    }

    // Jangan biarkan admin menghapus diri sendiri
    if (req.params.id === req.user.id && aktif === false) {
      return res.status(400).json({ success: false, message: 'Tidak dapat menonaktifkan akun Anda sendiri' });
    }

    if (nama) db.users[idx].nama = nama;
    if (role) db.users[idx].role = role;
    if (aktif !== undefined) db.users[idx].aktif = aktif;
    if (password) {
      if (password.length < 6) return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
      db.users[idx].password = await bcrypt.hash(password, 10);
    }
    db.users[idx].updated_at = new Date().toISOString();
    await writeDB(db);

    const { password: _, ...safeUser } = db.users[idx];
    res.json({ success: true, data: safeUser, message: 'User berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Delete user
app.delete('/api/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ success: false, message: 'Tidak dapat menghapus akun Anda sendiri' });
    }
    const db = await readDB();
    const idx = db.users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    db.users.splice(idx, 1);
    await writeDB(db);
    res.json({ success: true, message: 'User berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== ODC ROUTES =====================

app.get('/api/odc', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { search, page = 1, limit = 50 } = req.query;

    let data = db.odc;

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(o =>
        o.nama?.toLowerCase().includes(q) ||
        o.kode?.toLowerCase().includes(q) ||
        o.lokasi?.toLowerCase().includes(q)
      );
    }

    const total = data.length;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const totalPages = Math.ceil(total / limitNum) || 1;
    const offset = (pageNum - 1) * limitNum;
    const paged = data.slice(offset, offset + limitNum);

    res.json({ success: true, data: paged, pagination: { total, page: pageNum, limit: limitNum, totalPages } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/odc/:id', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const odc = db.odc.find(o => o.id === req.params.id);
    if (!odc) return res.status(404).json({ success: false, message: 'ODC tidak ditemukan' });
    res.json({ success: true, data: odc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/odc', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { nama, kode, lokasi, koordinat_lat, koordinat_lng, kapasitas, status, keterangan } = req.body;
    if (!nama || !kode || !lokasi) {
      return res.status(400).json({ success: false, message: 'Nama, kode, dan lokasi wajib diisi' });
    }
    if (db.odc.find(o => o.kode.trim().toLowerCase() === kode.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Kode ODC "${kode}" sudah ada, gunakan kode lain` });
    }
    const newODC = {
      id: uuidv4(), nama, kode, lokasi,
      koordinat_lat: koordinat_lat || '',
      koordinat_lng: koordinat_lng || '',
      kapasitas: parseInt(kapasitas) || 0,
      status: status || 'Aktif',
      keterangan: keterangan || '',
      created_by: req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.odc.push(newODC);
    await writeDB(db);
    res.status(201).json({ success: true, data: newODC, message: 'ODC berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/odc/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odc.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODC tidak ditemukan' });
    if (req.body.kode) {
      const dup = db.odc.find(o => o.id !== req.params.id && o.kode.trim().toLowerCase() === req.body.kode.trim().toLowerCase());
      if (dup) return res.status(400).json({ success: false, message: `Kode ODC "${req.body.kode}" sudah digunakan oleh ODC lain` });
    }
    db.odc[index] = { ...db.odc[index], ...req.body, updated_at: new Date().toISOString(), updated_by: req.user.username };
    await writeDB(db);
    res.json({ success: true, data: db.odc[index], message: 'ODC berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/odc/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odc.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODC tidak ditemukan' });
    db.odc.splice(index, 1);
    await writeDB(db);
    res.json({ success: true, message: 'ODC berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== ODP ROUTES =====================

app.get('/api/odp', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { odc_id, search, page = 1, limit = 50 } = req.query;

    // Lookup maps
    const odcMap = Object.fromEntries(db.odc.map(o => [o.id, o]));
    // Count pelanggan per ODP sekali
    const pelCountMap = {};
    db.pelanggan.forEach(p => { pelCountMap[p.odp_id] = (pelCountMap[p.odp_id] || 0) + 1; });

    let data = db.odp;
    if (odc_id) data = data.filter(o => o.odc_id === odc_id);

    if (search) {
      const q = search.toLowerCase();
      data = data.filter(o => {
        const odc = odcMap[o.odc_id];
        return (
          o.nama?.toLowerCase().includes(q) ||
          o.kode?.toLowerCase().includes(q) ||
          o.lokasi?.toLowerCase().includes(q) ||
          odc?.kode?.toLowerCase().includes(q)
        );
      });
    }

    const total = data.length;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const totalPages = Math.ceil(total / limitNum) || 1;
    const offset = (pageNum - 1) * limitNum;

    const enriched = data.slice(offset, offset + limitNum).map(odp => {
      const odc = odcMap[odp.odc_id] || {};
      return {
        ...odp,
        odc_nama: odc.nama || '-',
        odc_kode: odc.kode || '-',
        terpakai: pelCountMap[odp.id] || 0
      };
    });

    res.json({ success: true, data: enriched, pagination: { total, page: pageNum, limit: limitNum, totalPages } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/odp/:id', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const odp = db.odp.find(o => o.id === req.params.id);
    if (!odp) return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
    res.json({ success: true, data: odp });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cari ODP berdasarkan kode (dipakai untuk fitur scan QR/barcode di box ODP)
app.get('/api/odp/by-kode/:kode', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const kode = req.params.kode.trim().toLowerCase();
    const odp = db.odp.find(o => o.kode.trim().toLowerCase() === kode);
    if (!odp) return res.status(404).json({ success: false, message: 'ODP dengan kode tersebut tidak ditemukan' });
    const data = {
      ...odp,
      odc_nama: db.odc.find(o => o.id === odp.odc_id)?.nama || '-',
      odc_kode: db.odc.find(o => o.id === odp.odc_id)?.kode || '-',
      terpakai: db.pelanggan.filter(p => p.odp_id === odp.id).length
    };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/odp', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { nama, kode, odc_id, lokasi, koordinat_lat, koordinat_lng, kapasitas, status, keterangan } = req.body;
    if (!nama || !kode || !odc_id || !lokasi) {
      return res.status(400).json({ success: false, message: 'Nama, kode, ODC, dan lokasi wajib diisi' });
    }
    if (!db.odc.find(o => o.id === odc_id)) {
      return res.status(400).json({ success: false, message: 'ODC tidak ditemukan' });
    }
    if (db.odp.find(o => o.kode.trim().toLowerCase() === kode.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Kode ODP "${kode}" sudah ada, gunakan kode lain` });
    }
    const newODP = {
      id: uuidv4(), nama, kode, odc_id, lokasi,
      koordinat_lat: koordinat_lat || '',
      koordinat_lng: koordinat_lng || '',
      kapasitas: parseInt(kapasitas) || 0,
      status: status || 'Aktif',
      keterangan: keterangan || '',
      created_by: req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.odp.push(newODP);
    await writeDB(db);
    res.status(201).json({ success: true, data: newODP, message: 'ODP berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/odp/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odp.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
    if (req.body.kode) {
      const dup = db.odp.find(o => o.id !== req.params.id && o.kode.trim().toLowerCase() === req.body.kode.trim().toLowerCase());
      if (dup) return res.status(400).json({ success: false, message: `Kode ODP "${req.body.kode}" sudah digunakan oleh ODP lain` });
    }
    db.odp[index] = { ...db.odp[index], ...req.body, updated_at: new Date().toISOString(), updated_by: req.user.username };
    await writeDB(db);
    res.json({ success: true, data: db.odp[index], message: 'ODP berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/odp/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.odp.findIndex(o => o.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'ODP tidak ditemukan' });
    db.odp.splice(index, 1);
    await writeDB(db);
    res.json({ success: true, message: 'ODP berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== PELANGGAN ROUTES =====================

app.get('/api/pelanggan', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { odp_id, search, page = 1, limit = 50 } = req.query;

    // Buat lookup map O(1) — hindari .find() berulang di tiap baris
    const odpMap = Object.fromEntries(db.odp.map(o => [o.id, o]));
    const odcMap = Object.fromEntries(db.odc.map(o => [o.id, o]));

    let data = db.pelanggan;

    // Filter by ODP
    if (odp_id) data = data.filter(p => p.odp_id === odp_id);

    // Server-side search: nama, no_telp, no_pelanggan, kode ODP
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(p => {
        const odp = odpMap[p.odp_id];
        return (
          p.nama?.toLowerCase().includes(q) ||
          p.no_telp?.toLowerCase().includes(q) ||
          p.no_pelanggan?.toLowerCase().includes(q) ||
          odp?.kode?.toLowerCase().includes(q) ||
          odp?.nama?.toLowerCase().includes(q)
        );
      });
    }

    const total = data.length;
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const totalPages = Math.ceil(total / limitNum) || 1;
    const offset = (pageNum - 1) * limitNum;

    // Ambil hanya data halaman ini, baru enrich
    const enriched = data.slice(offset, offset + limitNum).map(p => {
      const odp = odpMap[p.odp_id] || {};
      const odc = odcMap[odp.odc_id] || {};
      return {
        ...p,
        odp_nama: odp.nama || '-',
        odp_kode: odp.kode || '-',
        odc_nama: odc.nama || '-'
      };
    });

    res.json({
      success: true,
      data: enriched,
      pagination: { total, page: pageNum, limit: limitNum, totalPages }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/pelanggan', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const { nama, no_pelanggan, odp_id, port, alamat, koordinat_lat, koordinat_lng, no_telp, paket, status, keterangan } = req.body;
    if (!nama || !odp_id) {
      return res.status(400).json({ success: false, message: 'Nama dan ODP wajib diisi' });
    }
    if (!db.odp.find(o => o.id === odp_id)) {
      return res.status(400).json({ success: false, message: 'ODP tidak ditemukan' });
    }
    if (no_pelanggan && db.pelanggan.find(p => p.no_pelanggan && p.no_pelanggan.trim().toLowerCase() === no_pelanggan.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `No. Pelanggan "${no_pelanggan}" sudah terdaftar` });
    }
    if (no_telp && nama && db.pelanggan.find(p => p.no_telp && p.no_telp.trim() === no_telp.trim() && p.nama && p.nama.trim().toLowerCase() === nama.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Pelanggan "${nama}" dengan No. Telepon "${no_telp}" sudah terdaftar` });
    }
    if (db.pelanggan.find(p => p.odp_id === odp_id && p.nama && p.nama.trim().toLowerCase() === nama.trim().toLowerCase())) {
      return res.status(400).json({ success: false, message: `Pelanggan dengan nama "${nama}" sudah terdaftar di ODP ini` });
    }
    const newPelanggan = {
      id: uuidv4(), nama, no_pelanggan, odp_id,
      port: port || '', alamat: alamat || '',
      koordinat_lat: koordinat_lat || '',
      koordinat_lng: koordinat_lng || '',
      no_telp: no_telp || '',
      paket: paket || '',
      status: status || 'Aktif',
      keterangan: keterangan || '',
      created_by: req.user.username,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    db.pelanggan.push(newPelanggan);
    await writeDB(db);
    res.status(201).json({ success: true, data: newPelanggan, message: 'Pelanggan berhasil ditambahkan' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/pelanggan/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.pelanggan.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    if (req.body.no_pelanggan) {
      const dup = db.pelanggan.find(p => p.id !== req.params.id && p.no_pelanggan && p.no_pelanggan.trim().toLowerCase() === req.body.no_pelanggan.trim().toLowerCase());
      if (dup) return res.status(400).json({ success: false, message: `No. Pelanggan "${req.body.no_pelanggan}" sudah digunakan oleh pelanggan lain` });
    }
    if (req.body.no_telp) {
      const namaCheckTelp = req.body.nama || db.pelanggan[index].nama;
      const dupTelp = db.pelanggan.find(p => p.id !== req.params.id && p.no_telp && p.no_telp.trim() === req.body.no_telp.trim() && p.nama && namaCheckTelp && p.nama.trim().toLowerCase() === namaCheckTelp.trim().toLowerCase());
      if (dupTelp) return res.status(400).json({ success: false, message: `Pelanggan "${namaCheckTelp}" dengan No. Telepon "${req.body.no_telp}" sudah terdaftar` });
    }
    {
      const namaCheck = req.body.nama || db.pelanggan[index].nama;
      const odpCheck = req.body.odp_id || db.pelanggan[index].odp_id;
      const dupNama = db.pelanggan.find(p => p.id !== req.params.id && p.odp_id === odpCheck && p.nama && namaCheck && p.nama.trim().toLowerCase() === namaCheck.trim().toLowerCase());
      if (dupNama) return res.status(400).json({ success: false, message: `Pelanggan dengan nama "${namaCheck}" sudah terdaftar di ODP ini` });
    }
    db.pelanggan[index] = { ...db.pelanggan[index], ...req.body, updated_at: new Date().toISOString(), updated_by: req.user.username };
    await writeDB(db);
    res.json({ success: true, data: db.pelanggan[index], message: 'Pelanggan berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/pelanggan/:id', authMiddleware, crudMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const index = db.pelanggan.findIndex(p => p.id === req.params.id);
    if (index === -1) return res.status(404).json({ success: false, message: 'Pelanggan tidak ditemukan' });
    db.pelanggan.splice(index, 1);
    await writeDB(db);
    res.json({ success: true, message: 'Pelanggan berhasil dihapus' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== MAP =====================

// Data gabungan untuk peta: ODC, ODP, Pelanggan (yang punya koordinat) + rute kabel ODC-ODP
app.get('/api/map/all', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();

    const hasCoord = (o) => o.koordinat_lat && o.koordinat_lng &&
      !isNaN(parseFloat(o.koordinat_lat)) && !isNaN(parseFloat(o.koordinat_lng));

    const odc = db.odc.filter(hasCoord).map(o => ({
      id: o.id, nama: o.nama, kode: o.kode, lokasi: o.lokasi,
      lat: parseFloat(o.koordinat_lat), lng: parseFloat(o.koordinat_lng),
      kapasitas: o.kapasitas, status: o.status
    }));

    const odp = db.odp.filter(hasCoord).map(o => {
      const odcInduk = db.odc.find(x => x.id === o.odc_id);
      const terpakai = db.pelanggan.filter(p => p.odp_id === o.id).length;
      return {
        id: o.id, nama: o.nama, kode: o.kode, lokasi: o.lokasi,
        lat: parseFloat(o.koordinat_lat), lng: parseFloat(o.koordinat_lng),
        kapasitas: o.kapasitas, status: o.status, terpakai,
        odc_id: o.odc_id,
        odc_nama: odcInduk ? odcInduk.nama : '-',
        odc_kode: odcInduk ? odcInduk.kode : '-',
        odc_lat: odcInduk && hasCoord(odcInduk) ? parseFloat(odcInduk.koordinat_lat) : null,
        odc_lng: odcInduk && hasCoord(odcInduk) ? parseFloat(odcInduk.koordinat_lng) : null
      };
    });

    const pelanggan = db.pelanggan.filter(hasCoord).map(p => {
      const odpInduk = db.odp.find(x => x.id === p.odp_id);
      return {
        id: p.id, nama: p.nama, no_pelanggan: p.no_pelanggan, alamat: p.alamat,
        lat: parseFloat(p.koordinat_lat), lng: parseFloat(p.koordinat_lng),
        no_telp: p.no_telp, paket: p.paket, status: p.status,
        odp_id: p.odp_id,
        odp_nama: odpInduk ? odpInduk.nama : '-',
        odp_kode: odpInduk ? odpInduk.kode : '-',
        odp_lat: odpInduk && hasCoord(odpInduk) ? parseFloat(odpInduk.koordinat_lat) : null,
        odp_lng: odpInduk && hasCoord(odpInduk) ? parseFloat(odpInduk.koordinat_lng) : null
      };
    });

    res.json({
      success: true,
      data: { odc, odp, pelanggan },
      meta: {
        total_odc: db.odc.length, odc_with_coord: odc.length,
        total_odp: db.odp.length, odp_with_coord: odp.length,
        total_pelanggan: db.pelanggan.length, pelanggan_with_coord: pelanggan.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== DUPLICATE CHECK =====================

function findDuplicateGroups(arr, field) {
  const map = {};
  arr.forEach(item => {
    const val = (item[field] || '').toString().trim().toLowerCase();
    if (!val) return;
    if (!map[val]) map[val] = [];
    map[val].push(item);
  });
  return Object.values(map).filter(group => group.length > 1);
}

function findDuplicateGroupsByKey(arr, keyFn) {
  const map = {};
  arr.forEach(item => {
    const val = keyFn(item);
    if (!val) return;
    if (!map[val]) map[val] = [];
    map[val].push(item);
  });
  return Object.values(map).filter(group => group.length > 1);
}

app.get('/api/duplicates', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const odpMap = Object.fromEntries(db.odp.map(o => [o.id, o]));

    const odcDup = findDuplicateGroups(db.odc, 'kode').map(group => ({
      field: 'kode',
      items: group.map(o => ({ id: o.id, nama: o.nama, kode: o.kode, created_at: o.created_at }))
    }));

    const odpDup = findDuplicateGroups(db.odp, 'kode').map(group => ({
      field: 'kode',
      items: group.map(o => ({ id: o.id, nama: o.nama, kode: o.kode, created_at: o.created_at }))
    }));

    // Pelanggan: cek 3 kriteria sekaligus karena no_pelanggan sering kosong (tidak ada di form input)
    // No. Telepon hanya dianggap duplikat jika NAMA juga sama (1 nomor HP boleh dipakai untuk lebih dari 1 pemasangan, mis. beda anggota keluarga)
    const pelNoTelpDup = findDuplicateGroupsByKey(db.pelanggan, p => {
      const telp = p.no_telp && p.no_telp.trim();
      const nama = (p.nama || '').trim().toLowerCase();
      if (!telp || !nama) return null;
      return telp + '|' + nama;
    }).map(group => ({
      field: 'no_telp',
      label: 'No. Telepon + Nama',
      items: group.map(p => ({ id: p.id, nama: p.nama, value: p.no_telp, odp_nama: odpMap[p.odp_id]?.nama || '-', created_at: p.created_at }))
    }));

    const pelNamaOdpDup = findDuplicateGroupsByKey(db.pelanggan, p => {
      const nama = (p.nama || '').trim().toLowerCase();
      if (!nama || !p.odp_id) return null;
      return nama + '|' + p.odp_id;
    }).map(group => ({
      field: 'nama_odp',
      label: 'Nama + ODP',
      items: group.map(p => ({ id: p.id, nama: p.nama, value: `${p.nama} (ODP: ${odpMap[p.odp_id]?.nama || '-'})`, odp_nama: odpMap[p.odp_id]?.nama || '-', created_at: p.created_at }))
    }));

    const pelNoPelangganDup = findDuplicateGroups(db.pelanggan, 'no_pelanggan').map(group => ({
      field: 'no_pelanggan',
      label: 'No. Pelanggan',
      items: group.map(p => ({ id: p.id, nama: p.nama, value: p.no_pelanggan, odp_nama: odpMap[p.odp_id]?.nama || '-', created_at: p.created_at }))
    }));

    const pelangganDup = [...pelNoTelpDup, ...pelNamaOdpDup, ...pelNoPelangganDup];

    res.json({
      success: true,
      data: { odc: odcDup, odp: odpDup, pelanggan: pelangganDup },
      meta: {
        total_odc_dup: odcDup.length,
        total_odp_dup: odpDup.length,
        total_pelanggan_dup: pelangganDup.length
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===================== STATS =====================

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const db = await readDB();
    const stats = {
      total_odc: db.odc.length,
      odc_aktif: db.odc.filter(o => o.status === 'Aktif').length,
      total_odp: db.odp.length,
      odp_aktif: db.odp.filter(o => o.status === 'Aktif').length,
      total_pelanggan: db.pelanggan.length,
      pelanggan_aktif: db.pelanggan.filter(p => p.status === 'Aktif').length,
      total_kapasitas_odp: db.odp.reduce((sum, o) => sum + (parseInt(o.kapasitas) || 0), 0),
      total_terpakai: db.pelanggan.length
    };
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
  });
});