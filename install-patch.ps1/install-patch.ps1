# install-patch.ps1 — 把本地补丁写回 dsh-pdf 插件目录 (插件升级后重放)
$ErrorActionPreference = 'Stop'
$target = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web\node_modules\@RCYD857\dsh-pdf-patched\lib'
if (-not (Test-Path $target)) { throw "找不到插件 lib 目录: $target" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (Test-Path (Join-Path $target 'pdf-core.js')) {
  Copy-Item (Join-Path $target 'pdf-core.js') (Join-Path $target ("pdf-core.js.bak-" + $stamp)) -Force
  Write-Output ("已备份原文件 -> pdf-core.js.bak-" + $stamp)
}
Copy-Item (Join-Path $here 'pdf-core.js') (Join-Path $target 'pdf-core.js') -Force
Copy-Item (Join-Path $here 'render-child.mjs') (Join-Path $target 'render-child.mjs') -Force
Write-Output '补丁已写入, 重启 DSH 服务后生效 (托盘菜单「重启服务」)。'
