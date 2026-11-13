@echo off
rem Starts the SeatNav data collector in the background (no window).
rem Safe to run twice: a second copy sees the first one and exits.
start "" pythonw "%~dp0collector.py" run
