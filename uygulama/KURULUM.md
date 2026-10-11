# Blue Heaven Kasa — Kurulum ve Kullanım

## Kurulum (resepsiyon bilgisayarı, Windows)

1. `Blue Heaven Kasa Setup 1.0.0.exe` dosyasını bilgisayara indirin ve çift tıklayın.
2. Windows **“Windows bilgisayarınızı korudu”** uyarısı verirse: **Ek bilgi → Yine de çalıştır**.
   (Program imzalı bir yayıncıdan gelmediği için bu uyarı normaldir.)
3. Kurulum bitince masaüstünde **Blue Heaven Kasa** simgesi oluşur.
4. İlk açılışta kasada o an bulunan TL / € / $ / £ tutarını yazıp **Başla**’ya basın.

Program internet olmadan çalışır. Yönetici yetkisi gerekmez.

## Günlük kullanım

- **Satış:** Ürün kutusuna birkaç harf yazın (ör. `dam`) → `Enter` → adet → `Enter`. Ödeme şeklini seçmeyi unutmayın.
- **Oda hesabı:** Ödeme olarak “Oda hesabına yaz”. Misafir çıkarken **Oda Hesapları → Hesabı kapat**.
- **Para Bozma / Gider / Cengiz Bey:** ilgili sekmeden.
- **Yanlış kayıt:** listede **İptal** (silinmez, üstü çizili kalır). Sadece açık günün kayıtları iptal edilebilir.
- **Gün Sonu:** Kasayı sayıp yazın → **Günü kapat**. Sayılan tutar ertesi güne devreder.
- **Rapor** ve **Ayarlar** şifrelidir (Cengiz Bey).

## Kayıt ve yedek

- Her işlem **Kaydet’e basıldığı an** diske yazılır. Elektrik kesilse bile kaydedilmiş işlemler kaybolmaz.
- Program her açılışta ve her gün sonunda kendiliğinden yedek alır (son 30 yedek saklanır):
  - `Belgeler\BlueHeavenKasa-Yedek`
  - Program veri klasörü: `%APPDATA%\Blue Heaven Kasa\veri\yedekler`
  - USB bellekte kök dizinde **KasaYedek** adlı klasör varsa, bellek takılıyken oraya da.
- Geri yükleme: **Ayarlar → Yedekler → Geri yükle**.
- Asıl veri dosyası: `%APPDATA%\Blue Heaven Kasa\veri\kasa.db`

## Kurlar ve fiyatlar

**Ayarlar → Kurlar** ve **Ayarlar → Ürünler ve fiyatlar**. Kur değişikliği sadece bundan sonraki işlemleri etkiler; geçmiş kayıtlar kendi günündeki kurla kalır.

---

### Geliştirici notları

```
npm install        # bağımlılıklar
npm test           # çekirdek iş kuralları testi
npm run dev        # arayüzü tarayıcıda çalıştır (http://localhost:8766, veriler veri-dev/)
npm start          # Electron penceresinde çalıştır
npm run dist:win   # Windows kurulum dosyası → dist/
```

- `src/core/` — veritabanı (sql.js), iş kuralları, yedekleme. Arayüzden bağımsız, `test/smoke.js` ile test edilir.
- `src/renderer/` — arayüz (HTML/CSS/JS). Çekirdeğe `window.kasa.call()` (Electron) veya `/api` (geliştirme) ile ulaşır.
