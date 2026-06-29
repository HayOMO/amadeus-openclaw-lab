$ErrorActionPreference = 'Stop'

Write-Host 'Install/upgrade Pixiv resource backend'
Write-Host 'Backend: gallery-dl, used as the mature Pixiv extractor/downloader.'
Write-Host ''

python -m pip install --user --upgrade gallery-dl

Write-Host ''
Write-Host 'Check:'
python -m gallery_dl --version
Write-Host ''
Write-Host 'Pixiv backend ready.'
