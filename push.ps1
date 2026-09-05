# ============================================================
#  w25077.github.io 一键推送脚本（Windows PowerShell / PS 7）
#  用法：在仓库目录运行  ./push.ps1
#  前置条件：本机 git 已存有 GitHub 凭据（~/.git-credentials）
#  注意：本文件为 UTF-8 with BOM 编码，请勿另存为无 BOM 的 UTF-8
# ============================================================

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/w25077/w25077.github.io.git'

Write-Host ''
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host '  w25077.github.io 个人主页 · 一键推送'           -ForegroundColor Cyan
Write-Host '==============================================' -ForegroundColor Cyan
Write-Host ''

# 1. 检查是否在 git 仓库内
if (-not (Test-Path '.git')) {
    Write-Error '当前目录不是 git 仓库 —— 请在 w25077.github.io 仓库目录内运行本脚本。'
}

# 2. 检查 git 身份（git config 未设置时静默退出码 1，不产生 stderr）
$name  = git config user.name
$email = git config user.email
if ($LASTEXITCODE -ne 0 -or -not $name -or -not $email) {
    Write-Warning '尚未配置 git 身份（user.name / user.email），请先执行：'
    Write-Warning '  git config user.name  "w25077"'
    Write-Warning "  git config user.email '你的邮箱'"
    exit 1
}
Write-Host "[1/3] git 身份: $name <$email>" -ForegroundColor Green

# 3. 添加 remote（已存在则跳过）
$remote = git config --get remote.origin.url
if ($LASTEXITCODE -ne 0 -or -not $remote) {
    git remote add origin $RepoUrl
    if ($LASTEXITCODE -ne 0) {
        Write-Error "添加 remote 失败：$RepoUrl"
    }
    Write-Host "[2/3] 已添加 remote origin -> $RepoUrl" -ForegroundColor Green
} else {
    Write-Host "[2/3] remote origin 已存在: $remote" -ForegroundColor Green
}

# 4. 推送 main 分支（2>&1 合并 stderr，避免 PowerShell 5.1 的 NativeCommandError）
Write-Host "[3/3] 正在推送 main 分支 ..." -ForegroundColor Green
$env:GIT_TERMINAL_PROMPT = '0'
git push -u origin main 2>&1 | ForEach-Object { Write-Host $_.ToString() }
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host '推送失败。请确认：' -ForegroundColor Red
    Write-Host '  1) 已在 GitHub 网页端创建同名空仓库（仓库名必须为 w25077.github.io）' -ForegroundColor Red
    Write-Host '  2) 本机已保存 GitHub 凭据（首次 push 时按提示输入账号与 PAT）' -ForegroundColor Red
    Write-Host '  3) 网络可访问 github.com' -ForegroundColor Red
    exit 1
}
Write-Host ''
Write-Host '推送完成！下一步：' -ForegroundColor Yellow
Write-Host '  1) 打开 GitHub 仓库 Settings -> Pages' -ForegroundColor Yellow
Write-Host '  2) Source 选择 Deploy from a branch -> main / (root) -> Save' -ForegroundColor Yellow
Write-Host '  3) 稍候访问 https://w25077.github.io' -ForegroundColor Yellow
Write-Host ''