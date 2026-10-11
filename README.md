# Blue Heaven Kasa

Blue Heaven Apart resepsiyonu için çevrimdışı çalışan kasa programı (Windows).

- Satış, para bozma (€ / $ / £), gider, patron hareketleri, oda hesapları
- Gün sonu sayımı ve devir, geçmiş günler
- Şifreli rapor ve ayarlar
- Her işlem anında diske yazılır; açılışta ve gün sonunda otomatik yedek
- GitHub Releases üzerinden otomatik güncelleme (internet yoksa program normal çalışır)

Kurulum ve geliştirme notları: [uygulama/KURULUM.md](uygulama/KURULUM.md)

## Yeni sürüm yayınlama

```
cd uygulama
npm test
# package.json içindeki "version" değerini artırın (ör. 1.0.2)
GH_TOKEN=<github-token> npm run release:win
```

Yayınlanan sürüm, resepsiyon bilgisayarındaki programa bir sonraki açılışta (veya 4 saat içinde) kendiliğinden iner.
