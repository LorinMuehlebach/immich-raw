# Feature requests

Ideas that are wanted but not built yet, with what stands in the way.

## Export

- **Content Credentials (C2PA).** Signing an export needs a C2PA manifest (JUMBF in JPEG APP11
  segments), a hash of the file and a signature with an X.509 certificate. A self-signed certificate
  shows as an unknown signer, so this needs a certificate the user brings, or signing on a server.
- **More bits and spaces for AVIF and JPEG XL.** jSquash's JPEG XL encoder takes 8-bit sRGB only.
  Its AVIF encoder takes 10 and 12 bits, but Adobe RGB and ProPhoto have no colour code there and
  would need an ICC profile added to the file's item properties.
