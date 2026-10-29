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
    res.json({ success: true, data: db.odc });
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
    const { odc_id } = req.query;
    let data = db.odp;
    if (odc_id) data = data.filter(o => o.odc_id === odc_id);
    data = data.map(odp => ({
      ...odp,
      odc_nama: db.odc.find(o => o.id === odp.odc_id)?.nama || '-',
      odc_kode: db.odc.find(o => o.id === odp.odc_id)?.kode || '-',
      terpakai: db.pelanggan.filter(p => p.odp_id === odp.id).length
    }));
    res.json({ success: true, data });
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
    const { odp_id } = req.query;
    let data = db.pelanggan;
    if (odp_id) data = data.filter(p => p.odp_id === odp_id);
    data = data.map(p => ({
      ...p,
      odp_nama: db.odp.find(o => o.id === p.odp_id)?.nama || '-',
      odp_kode: db.odp.find(o => o.id === p.odp_id)?.kode || '-',
      odc_nama: db.odc.find(o => o.id === db.odp.find(od => od.id === p.odp_id)?.odc_id)?.nama || '-'
    }));
    res.json({ success: true, data });
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
      total_kapasitas_odp: db.odp.reduce((sum, o) => sum + (o.kapasitas || 0), 0),
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