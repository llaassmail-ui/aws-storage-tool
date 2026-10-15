@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path (Get-Location) 'launcher.ps1'), [Text.Encoding]::UTF8)))"
if errorlevel 1 pause
