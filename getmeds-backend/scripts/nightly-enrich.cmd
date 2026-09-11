@echo off
REM ===========================================================================
REM  Nightly Zoho history enrichment — the 3c-2 campaign, run off-hours.
REM
REM  Sep 11, 2026. Enriching ~60,000 adopted orders is ~120,000 Zoho GETs, so
REM  it cannot be done in one sitting. It is spread over nights instead, for
REM  two reasons:
REM
REM    1. Zoho Books enforces a daily call budget per org.
REM    2. This shares a Supabase pooler with the deployed app. A bulk run
REM       during the working day made /api/auth/login return 500s for valid
REM       accounts. Batch mode (lib/batch-job.js) caps this job at 2
REM       connections, and running it overnight means the contention that
REM       remains lands when nobody is logged in.
REM
REM  --stop-at 06:00 ends the run before the working day whatever is left;
REM  the backlog is picked up again the following night. Interrupting it is
REM  safe at any point — each order is stamped only after its detail lands.
REM
REM  Registered as Scheduled Task "GetMeds Nightly Zoho Enrichment".
REM  Remove with:  schtasks /delete /tn "GetMeds Nightly Zoho Enrichment" /f
REM ===========================================================================

setlocal

set "BACKEND=%~dp0.."
set "LOGDIR=%BACKEND%\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

REM One log per night, so a morning check is a single file rather than a scroll.
for /f "tokens=1-3 delims=/-. " %%a in ("%DATE%") do set "STAMP=%%c%%b%%a"
set "LOG=%LOGDIR%\enrich-%STAMP%.log"

cd /d "%BACKEND%"

echo ============================================================ >> "%LOG%"
echo Nightly enrichment starting %DATE% %TIME% >> "%LOG%"
echo ============================================================ >> "%LOG%"

REM --all drains the backlog; --stop-at hands the machine back at 6am.
node scripts\enrich-zoho-history.js --yes --all --stop-at 06:00 >> "%LOG%" 2>&1

echo. >> "%LOG%"
echo Finished %DATE% %TIME% with exit code %ERRORLEVEL% >> "%LOG%"

endlocal
