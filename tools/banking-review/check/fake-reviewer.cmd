@echo off
rem Stand-in for claude.exe in check-promotion.ps1: ignores its arguments.
node "%~dp0fake-reviewer.mjs"
