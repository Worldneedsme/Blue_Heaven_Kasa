# Elektra kesif raporu
# Bu betik SADECE OKUR: hicbir dosyayi, ayari veya Elektra verisini degistirmez.
# Misafir bilgisi okumaz; sadece hizmet adlarini, klasor/dosya adlarini ve boyutlarini listeler.
# Sonuc masaustune "elektra-kesif.txt" olarak yazilir.

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'elektra-kesif.txt'
$r = New-Object System.Collections.Generic.List[string]
function Add($s) { $r.Add([string]$s) }

Add "Elektra kesif raporu - $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
Add "Bilgisayar: $env:COMPUTERNAME  Windows: $((Get-CimInstance Win32_OperatingSystem).Caption)"

Add ""
Add "== Veritabani ile ilgili hizmetler =="
$pat = 'sql|firebird|interbase|oracle|postgres|mysql|maria|elektra|advantage|pervasive|btrieve'
Get-Service | Where-Object { $_.Name -match $pat -or $_.DisplayName -match $pat } |
  ForEach-Object { Add ("{0} | {1} | {2}" -f $_.Name, $_.DisplayName, $_.Status) }

Add ""
Add "== Calisan ilgili programlar =="
Get-Process | Where-Object { $_.ProcessName -match 'elektra|sqlservr|fbserver|fb_inet|firebird|ibserver|oracle|tnslsnr|postgres|mysqld' } |
  ForEach-Object { $p = $_; try { Add ("{0} | {1}" -f $p.ProcessName, $p.Path) } catch { Add $p.ProcessName } }

Add ""
Add "== Elektra klasorleri =="
$cands = @()
$roots = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Free -ne $null } | ForEach-Object { $_.Root }
foreach ($root in $roots) {
  foreach ($base in @($root, (Join-Path $root 'Program Files'), (Join-Path $root 'Program Files (x86)'))) {
    if (Test-Path $base) {
      $cands += Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'elektra|e2005|talya' }
    }
  }
}
# Masaustu / Baslat menusu kisayollarindan Elektra'nin kurulu oldugu klasoru bul
$sh = New-Object -ComObject WScript.Shell
$lnkDirs = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
)
foreach ($d in $lnkDirs) {
  if (Test-Path $d) {
    Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'elektra|e2005' } | ForEach-Object {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      Add ("Kisayol: {0} -> {1}" -f $_.Name, $t)
      if ($t) { $dir = Split-Path $t -Parent; if ($dir -and (Test-Path $dir)) { $cands += Get-Item $dir } }
    }
  }
}
$cands = $cands | Sort-Object FullName -Unique
if (-not $cands) { Add "Elektra klasoru bulunamadi." }

$dbExt = '.fdb','.gdb','.ib','.mdf','.ldf','.mdb','.accdb','.db','.dbf','.dat','.ora','.sqlite','.adt','.add','.btr','.idx','.cdx','.ndx','.px'
foreach ($c in $cands) {
  Add ""
  Add "-- Klasor: $($c.FullName)"
  $files = @(Get-ChildItem $c.FullName -Recurse -File -ErrorAction SilentlyContinue)
  Add ("Dosya sayisi: {0}" -f $files.Count)
  Add "Uzanti dagilimi:"
  $files | Group-Object { $_.Extension.ToLower() } | Sort-Object Count -Descending | Select-Object -First 25 |
    ForEach-Object { Add ("  {0,-8} {1}" -f $_.Name, $_.Count) }
  Add "Veritabani olabilecek dosyalar (en buyuk 40):"
  $files | Where-Object { $dbExt -contains $_.Extension.ToLower() } | Sort-Object Length -Descending | Select-Object -First 40 |
    ForEach-Object { Add ("  {0}  {1:N0} KB  {2:yyyy-MM-dd HH:mm}" -f $_.FullName.Substring($c.FullName.Length), ($_.Length / 1KB), $_.LastWriteTime) }
  Add "Ayar dosyalari (sifre iceren satirlar gizlenir):"
  $files | Where-Object { $_.Extension -match '^\.(ini|cfg|conf|config|xml|udl)$' -and $_.Length -lt 200KB } | Select-Object -First 15 | ForEach-Object {
    Add ("  [{0}]" -f $_.FullName.Substring($c.FullName.Length))
    Get-Content $_.FullName -ErrorAction SilentlyContinue |
      Where-Object { $_ -match 'server|database|data source|host|path|alias|provider|dsn|port|catalog' } |
      Select-Object -First 15 | ForEach-Object {
        if ($_ -match '(?i)pass|pwd|sifre') { Add "    (sifre iceren satir gizlendi)" } else { Add ("    " + $_) }
      }
  }
}

Add ""
Add "== ODBC veri kaynaklari =="
foreach ($k in 'HKLM:\SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources', 'HKLM:\SOFTWARE\WOW6432Node\ODBC\ODBC.INI\ODBC Data Sources', 'HKCU:\SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources') {
  if (Test-Path $k) {
    (Get-ItemProperty $k).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } |
      ForEach-Object { Add ("{0} | {1}" -f $_.Name, $_.Value) }
  }
}

$r | Out-File -FilePath $out -Encoding UTF8
Write-Host ""
Write-Host "Rapor hazir: $out"
Write-Host "Kapatmak icin Enter'a basin."
Read-Host | Out-Null
