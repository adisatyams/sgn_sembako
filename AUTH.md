# Login + 2FA (email)

Alur: email + password → kode 6 digit dikirim ke email admin → kode benar → sesi login 7 hari.

Semua endpoint Worker (`/api/sync/*`, `/api/d1/all`, `/api/init-db`, `/api/sipajak/*`) sekarang wajib sesi login.
Hanya `/`, `/health`, `/api/health` yang tetap publik.

## Setup (sekali saja)

1. Daftar di https://resend.com memakai email **adi.satya.ms@gmail.com**, lalu buat API key.
   Tanpa domain terverifikasi, Resend hanya mengizinkan kirim ke email pemilik akunnya
   (cukup untuk kasus ini). Jika nanti pakai domain sendiri, set `MAIL_FROM`.
2. Isi secret di Worker:

   ```bash
   npx wrangler secret put ADMIN_INITIAL_PASSWORD   # password awal
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put AUTH_PEPPER              # opsional, string acak panjang
   ```

3. Deploy: `npx wrangler deploy`
4. Login pertama kali membuat akun otomatis (password di-hash PBKDF2-SHA256, tidak disimpan polos).
   Setelah itu password diubah lewat menu **Ganti password** di aplikasi, dan secret
   `ADMIN_INITIAL_PASSWORD` boleh dihapus (`npx wrangler secret delete ADMIN_INITIAL_PASSWORD`).

Tabel `auth_users`, `auth_challenges`, `auth_sessions` dibuat otomatis di D1.

## Endpoint

| Method | Path | Fungsi |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` → kirim kode 2FA, balas `{challengeId}` |
| POST | `/api/auth/verify-2fa` | `{challengeId, code}` → balas `{token}` |
| POST | `/api/auth/resend` | `{challengeId}` → kirim ulang kode (jeda 60 detik, maks 5x) |
| GET | `/api/auth/me` | cek sesi (butuh `Authorization: Bearer <token>`) |
| POST | `/api/auth/logout` | akhiri sesi |
| POST | `/api/auth/change-password` | `{currentPassword, newPassword}` |

## Pengaman

- Salah password 5x → akun terkunci 15 menit.
- Kode 2FA berlaku 5 menit, maksimal 5 kali salah, sekali pakai, disimpan sebagai hash.
- Token sesi acak 256-bit, disimpan sebagai hash; ganti password mengeluarkan perangkat lain.
- Email login hanya `adi.satya.ms@gmail.com` (ubah lewat variabel `ADMIN_EMAIL` bila perlu).
