#!/usr/bin/env python3
"""Owns the serial port, writes timestamped (local time, ms) lines to bot.log at the repo root.
Usage: python logger.py [port] [baud]   (needs pyserial: use the ESP-IDF python env)
Marker: tools/mark.sh "<what I did>"
"""
import os, sys, time, serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbserial-110"
BAUD = int(sys.argv[2]) if len(sys.argv) > 2 else 115200  # monitor baud (not flash baud)
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bot.log")


def ts():
	t = time.time()
	return time.strftime("%H:%M:%S", time.localtime(t)) + f".{int(t * 1000) % 1000:03d}"


def open_port():
	# Don't toggle DTR/RTS on open, or the bot resets every time the logger starts
	ser = serial.Serial()
	ser.port, ser.baudrate, ser.timeout = PORT, BAUD, 0.5
	ser.dtr = False
	ser.rts = False
	ser.open()
	return ser


with open(LOG, "a", buffering=1) as f:
	f.write(f"\n===== logger started {ts()} =====\n")
	ser, buf, down_since = None, b"", None
	while True:
		if ser is None:
			try:
				ser = open_port()
				if down_since is not None:
					f.write(f"{ts()} [logger] serial port back after {time.time() - down_since:.0f}s\n")
				down_since = None
			except (serial.SerialException, OSError) as e:
				if down_since is None:
					down_since = time.time()
					f.write(f"{ts()} [logger] cannot open {PORT}: {e} (retrying every 2s)\n")
				time.sleep(2)
				continue
		try:
			buf += ser.read(4096)
		except (serial.SerialException, OSError) as e:
			f.write(f"{ts()} [logger] serial error: {e} (reopening)\n")
			try:
				ser.close()
			except Exception:
				pass
			ser, buf, down_since = None, b"", time.time()
			continue
		while b"\n" in buf:
			line, buf = buf.split(b"\n", 1)
			text = line.decode("utf-8", "replace").rstrip("\r")
			f.write(f"{ts()} {text}\n")
