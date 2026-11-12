-- QR clock-in: a code on a screen (or poster) at the venue that crew scan with their own phone.
ALTER TABLE events ADD COLUMN qr_clock boolean NOT NULL DEFAULT false, ADD COLUMN qr_secret text;
