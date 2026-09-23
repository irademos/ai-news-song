@echo off
rem Runs the YouTube transcript cache from Windows Task Scheduler and appends output
rem to cache-transcripts.log in the repo folder. Reads FIREBASE_DATABASE_URL from .env.
cd /d "%~dp0.."
node scripts\cache-youtube-transcripts.js >> cache-transcripts.log 2>&1
