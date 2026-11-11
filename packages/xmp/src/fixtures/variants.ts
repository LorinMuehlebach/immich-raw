// Element-form properties (as Adobe Bridge / exiftool write them), split across two
// rdf:Description blocks, with a non-"crs" prefix bound to the Camera Raw namespace.
export const ELEMENT_FORM = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:cr="http://ns.adobe.com/camera-raw-settings/1.0/">
   <cr:Exposure2012>+1.25</cr:Exposure2012>
   <cr:Contrast2012>-30</cr:Contrast2012>
   <cr:WhiteBalance>As Shot</cr:WhiteBalance>
   <cr:Temperature>6100</cr:Temperature>
   <cr:Treatment>Black &amp; White</cr:Treatment>
   <cr:ToneCurvePV2012Green>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>128, 140</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </cr:ToneCurvePV2012Green>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:camraw="http://ns.adobe.com/camera-raw-settings/1.0/" camraw:Vibrance="&#43;22" camraw:Sharpness='70'>
   <camraw:Name><rdf:Alt><rdf:li xml:lang="de-DE">Kräftig</rdf:li><rdf:li xml:lang="x-default">Punchy</rdf:li></rdf:Alt></camraw:Name>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

/** A process version 2010 sidecar (Lightroom 3 era). */
export const LEGACY_PV2010 = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:ProcessVersion="5.7" crs:Exposure="+0.50" crs:Brightness="+50" crs:FillLight="12" crs:Contrast="+25"/>
 </rdf:RDF>
</x:xmpmeta>`;
