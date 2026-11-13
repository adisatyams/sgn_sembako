// Google Apps Script: mengirim email kode 2FA dari Gmail Anda sendiri.
// Pasang di script.google.com, lalu Deploy > Web app (Execute as: Me, Access: Anyone).
// Tambahkan Script Property bernama SECRET (string acak panjang).
function doPost(e) {
  var out = function (t) { return ContentService.createTextOutput(t); };
  try {
    var d = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || d.secret !== secret) return out('forbidden');
    // Hanya boleh mengirim ke pemilik script (mencegah penyalahgunaan)
    if (String(d.to).toLowerCase() !== Session.getEffectiveUser().getEmail().toLowerCase()) return out('forbidden');
    MailApp.sendEmail({ to: d.to, subject: d.subject, body: d.text, htmlBody: d.html, name: 'SGN Sembako' });
    return out('ok');
  } catch (err) {
    return out('error');
  }
}
