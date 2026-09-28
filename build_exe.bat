@echo off
echo ========================================================
echo   Air-Gap Optical QR Transmitter - Building Standalone EXE
echo ========================================================
py -3 -m PyInstaller --noconfirm --onedir --windowed --name "AirGapQRSender" --collect-all windnd --add-data "web_scanner;web_scanner" sender_app.py
echo.
echo Build hoan tat! Thu muc ung dung: dist\AirGapQRSender\AirGapQRSender.exe
pause
