// Local corrections as Lightroom writes them. Shapes, value scales and the way the
// components are combined follow real sidecars and presets (Lightroom Classic 8, 11.4,
// 13-15); the coordinates of "Face" and "Vignette" are taken from real files.

const head = (attrs: string) => `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   ${attrs}>`;
const tail = `
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

/** A Lightroom Classic 14 sidecar of a 6000 x 4000 landscape raw with seven masks. */
export const MASK_GROUP_SIDECAR = `${head(`tiff:Orientation="1"
   xmp:CreatorTool="Adobe Photoshop Lightroom Classic 14.0 (Windows)"
   crs:Version="17.0"
   crs:ProcessVersion="15.4"
   crs:Exposure2012="+0.20"
   crs:HasSettings="True"`)}
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="Sky"
       crs:CorrectionSyncID="5D1C2C6F0C2B4E0A9E0A8F7E6D5C4B3A"
       crs:LocalExposure2012="-0.25"
       crs:LocalContrast2012="0"
       crs:LocalDehaze="0.2"
       crs:LocalTemperature="-0.1"
       crs:LocalLuminanceNoise="0"
       crs:LocalMoire="0.3"
       crs:LocalCurveRefineSaturation="100">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/Gradient"
         crs:MaskActive="true"
         crs:MaskName="Linear Gradient 1"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskValue="1"
         crs:ZeroX="0.5"
         crs:ZeroY="0.45"
         crs:FullX="0.5"
         crs:FullY="0.1"/>
        <rdf:li
         crs:What="Mask/CircularGradient"
         crs:MaskActive="true"
         crs:MaskName="Radial Gradient 1"
         crs:MaskBlendMode="1"
         crs:MaskInverted="false"
         crs:MaskValue="0"
         crs:Top="0.1"
         crs:Left="0.6"
         crs:Bottom="0.4"
         crs:Right="0.8"
         crs:Angle="0"
         crs:Midpoint="50"
         crs:Roundness="0"
         crs:Feather="50"
         crs:Flipped="true"
         crs:Version="2"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="0.8"
       crs:CorrectionActive="true"
       crs:CorrectionName="Face"
       crs:LocalWhites2012="0.15"
       crs:LocalHue="0.277778"
       crs:LocalToningHue="40"
       crs:LocalToningSaturation="0.3"
       crs:LocalCurveRefineSaturation="100">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/CircularGradient"
         crs:MaskActive="true"
         crs:MaskName="Radial Gradient 1"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskValue="1"
         crs:Top="0.792661"
         crs:Left="0.327810"
         crs:Bottom="0.571190"
         crs:Right="0.768964"
         crs:Angle="-25.7968"
         crs:Midpoint="50"
         crs:Roundness="0"
         crs:Feather="25"
         crs:Flipped="true"
         crs:Version="2"/>
        <rdf:li>
         <rdf:Description
          crs:What="Mask/RangeMask"
          crs:MaskActive="true"
          crs:MaskName="Luminance Range 1"
          crs:MaskBlendMode="1"
          crs:MaskInverted="true"
          crs:MaskValue="0">
         <crs:CorrectionRangeMask
          crs:Version="3"
          crs:Type="2"
          crs:Invert="false"
          crs:SampleType="0"
          crs:LumRange="0.200000 0.400000 0.600000 0.800000"
          crs:LuminanceDepthSampleInfo="0 0.548387 0.681925"/>
         </rdf:Description>
        </rdf:li>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="Brush"
       crs:LocalShadows2012="0.35"
       crs:LocalClarity2012="-0.4">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li>
         <rdf:Description
          crs:What="Mask/Aggregate"
          crs:MaskActive="true"
          crs:MaskName="Brush 1"
          crs:MaskBlendMode="0"
          crs:MaskInverted="false"
          crs:MaskValue="1">
         <crs:Masks>
          <rdf:Seq>
           <rdf:li>
            <rdf:Description
             crs:What="Mask/Paint"
             crs:MaskActive="true"
             crs:MaskBlendMode="0"
             crs:MaskInverted="false"
             crs:MaskValue="0.4"
             crs:Radius="0.02"
             crs:Flow="0.299998"
             crs:CenterWeight="0.16214">
            <crs:Dabs>
             <rdf:Seq>
              <rdf:li>h 0.1621</rdf:li>
              <rdf:li>f 0.3000</rdf:li>
              <rdf:li>d 0.200000 0.500000</rdf:li>
              <rdf:li>d 0.250000 0.500000</rdf:li>
              <rdf:li>r 0.030000</rdf:li>
              <rdf:li>d 0.300000 0.500000</rdf:li>
             </rdf:Seq>
            </crs:Dabs>
            </rdf:Description>
           </rdf:li>
           <rdf:li>
            <rdf:Description
             crs:What="Mask/Paint"
             crs:MaskActive="true"
             crs:MaskBlendMode="1"
             crs:MaskInverted="false"
             crs:MaskValue="0"
             crs:Radius="0.01"
             crs:Flow="1"
             crs:CenterWeight="0">
            <crs:Dabs>
             <rdf:Seq>
              <rdf:li>d 0.220000 0.500000</rdf:li>
              <rdf:li>d 0.240000 0.500000</rdf:li>
             </rdf:Seq>
            </crs:Dabs>
            </rdf:Description>
           </rdf:li>
          </rdf:Seq>
         </crs:Masks>
         </rdf:Description>
        </rdf:li>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="Leaves"
       crs:LocalSaturation="-0.5">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li>
         <rdf:Description
          crs:What="Mask/RangeMask"
          crs:MaskActive="true"
          crs:MaskName="Color Range 1"
          crs:MaskBlendMode="0"
          crs:MaskInverted="false"
          crs:MaskValue="1">
         <crs:CorrectionRangeMask>
          <rdf:Description
           crs:Version="3"
           crs:Type="1"
           crs:ColorAmount="0.494949"
           crs:Invert="false"
           crs:SampleType="0">
          <crs:PointModels>
           <rdf:Seq>
            <rdf:li>0.025415 0.608701 0.151080 0.769070 0.935510 0</rdf:li>
            <rdf:li>0.371385 0.204889 0.674661 0.322933 0.653548 1</rdf:li>
           </rdf:Seq>
          </crs:PointModels>
          </rdf:Description>
         </crs:CorrectionRangeMask>
         </rdf:Description>
        </rdf:li>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="Sky AI"
       crs:LocalExposure2012="-0.06"
       crs:LocalDehaze="0.05">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/Image"
         crs:MaskActive="true"
         crs:MaskName="Sky"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskValue="1"
         crs:MaskVersion="1"
         crs:MaskSubType="2"
         crs:ReferencePoint="0.500000 0.500000"
         crs:ErrorReason="0"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="false"
       crs:CorrectionName="Vignette"
       crs:LocalExposure2012="-0.0625">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/CircularGradient"
         crs:MaskActive="true"
         crs:MaskName="Radial Gradient 1"
         crs:MaskBlendMode="0"
         crs:MaskInverted="true"
         crs:MaskValue="1"
         crs:Top="-0.456202"
         crs:Left="0.080253"
         crs:Bottom="1.047745"
         crs:Right="1.182154"
         crs:Angle="0"
         crs:Midpoint="50"
         crs:Roundness="0"
         crs:Feather="37"
         crs:Flipped="false"
         crs:Version="2"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description
       crs:What="Correction"
       crs:CorrectionAmount="1"
       crs:CorrectionActive="true"
       crs:CorrectionName="Eyes"
       crs:LocalSharpness="0.25">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li
         crs:What="Mask/CircularGradient"
         crs:MaskActive="true"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskValue="1"
         crs:Top="0.3"
         crs:Left="0.45"
         crs:Bottom="0.36"
         crs:Right="0.55"
         crs:Angle="0"
         crs:Feather="60"
         crs:Flipped="true"
         crs:Version="2"/>
        <rdf:li
         crs:What="Mask/Image"
         crs:MaskActive="true"
         crs:MaskName="Iris and Pupil"
         crs:MaskBlendMode="0"
         crs:MaskInverted="false"
         crs:MaskValue="1"
         crs:MaskSubType="3"
         crs:MaskSubCategoryID="4"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>${tail}`;

/**
 * Process version 2012 corrections in element form, as Lightroom Classic 8 wrote them: a
 * graduated filter refined with brush strokes and a luminance range, two radial filters
 * (effect inside / outside) and a brush with an erasing stroke.
 */
export const LEGACY_PV2012 = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/">
  <tiff:Orientation>1</tiff:Orientation>
  <crs:ProcessVersion>11.0</crs:ProcessVersion>
  <crs:Exposure2012>0</crs:Exposure2012>
  <crs:GradientBasedCorrections>
   <rdf:Seq>
    <rdf:li rdf:parseType='Resource'>
     <crs:What>Correction</crs:What>
     <crs:CorrectionActive>true</crs:CorrectionActive>
     <crs:CorrectionAmount>1.000000</crs:CorrectionAmount>
     <crs:LocalExposure2012>0.125000</crs:LocalExposure2012>
     <crs:LocalContrast2012>0.200000</crs:LocalContrast2012>
     <crs:LocalExposure>0.000000</crs:LocalExposure>
     <crs:LocalToningHue>240.000000</crs:LocalToningHue>
     <crs:LocalToningSaturation>0.000000</crs:LocalToningSaturation>
     <crs:CorrectionMasks>
      <rdf:Seq>
       <rdf:li rdf:parseType='Resource'>
        <crs:What>Mask/Gradient</crs:What>
        <crs:MaskValue>1.000000</crs:MaskValue>
        <crs:ZeroX>0.500000</crs:ZeroX>
        <crs:ZeroY>0.700000</crs:ZeroY>
        <crs:FullX>0.500000</crs:FullX>
        <crs:FullY>1.000000</crs:FullY>
       </rdf:li>
       <rdf:li rdf:parseType='Resource'>
        <crs:What>Mask/Paint</crs:What>
        <crs:MaskValue>0.000000</crs:MaskValue>
        <crs:Radius>0.050000</crs:Radius>
        <crs:Flow>1.000000</crs:Flow>
        <crs:CenterWeight>0.000000</crs:CenterWeight>
        <crs:Dabs>
         <rdf:Seq>
          <rdf:li>d 0.500000 0.900000</rdf:li>
          <rdf:li>d 0.600000 0.900000</rdf:li>
         </rdf:Seq>
        </crs:Dabs>
       </rdf:li>
       <rdf:li rdf:parseType='Resource'>
        <crs:What>Mask/Paint</crs:What>
        <crs:MaskValue>1.000000</crs:MaskValue>
        <crs:Radius>0.050000</crs:Radius>
        <crs:Flow>1.000000</crs:Flow>
        <crs:CenterWeight>0.000000</crs:CenterWeight>
        <crs:Dabs>
         <rdf:Seq>
          <rdf:li>d 0.100000 0.300000</rdf:li>
         </rdf:Seq>
        </crs:Dabs>
       </rdf:li>
      </rdf:Seq>
     </crs:CorrectionMasks>
     <crs:CorrectionRangeMask rdf:parseType='Resource'>
      <crs:Version>+2</crs:Version>
      <crs:Type>2</crs:Type>
      <crs:ColorAmount>0.500000</crs:ColorAmount>
      <crs:LumMin>0.500000</crs:LumMin>
      <crs:LumMax>1.000000</crs:LumMax>
      <crs:LumFeather>0.300000</crs:LumFeather>
     </crs:CorrectionRangeMask>
    </rdf:li>
   </rdf:Seq>
  </crs:GradientBasedCorrections>
  <crs:CircularGradientBasedCorrections>
   <rdf:Seq>
    <rdf:li rdf:parseType='Resource'>
     <crs:What>Correction</crs:What>
     <crs:CorrectionActive>true</crs:CorrectionActive>
     <crs:CorrectionAmount>1.000000</crs:CorrectionAmount>
     <crs:LocalSharpness>0.299758</crs:LocalSharpness>
     <crs:LocalToningHue>340.781006</crs:LocalToningHue>
     <crs:CorrectionMasks>
      <rdf:Seq>
       <rdf:li rdf:parseType='Resource'>
        <crs:What>Mask/CircularGradient</crs:What>
        <crs:MaskValue>1.000000</crs:MaskValue>
        <crs:Angle>0.000000</crs:Angle>
        <crs:Top>0.328390</crs:Top>
        <crs:Left>0.491508</crs:Left>
        <crs:Bottom>0.503248</crs:Bottom>
        <crs:Right>0.594848</crs:Right>
        <crs:Feather>+50</crs:Feather>
        <crs:Flipped>true</crs:Flipped>
        <crs:Midpoint>+50</crs:Midpoint>
        <crs:Roundness>0</crs:Roundness>
        <crs:Version>+2</crs:Version>
       </rdf:li>
      </rdf:Seq>
     </crs:CorrectionMasks>
     <crs:CorrectionRangeMask rdf:parseType='Resource'>
      <crs:Version>+2</crs:Version>
      <crs:Type>0</crs:Type>
      <crs:ColorAmount>0.500000</crs:ColorAmount>
      <crs:LumMin>0.000000</crs:LumMin>
      <crs:LumMax>1.000000</crs:LumMax>
      <crs:LumFeather>0.500000</crs:LumFeather>
     </crs:CorrectionRangeMask>
    </rdf:li>
    <rdf:li rdf:parseType='Resource'>
     <crs:What>Correction</crs:What>
     <crs:CorrectionActive>true</crs:CorrectionActive>
     <crs:CorrectionAmount>1.000000</crs:CorrectionAmount>
     <crs:LocalExposure2012>-0.100000</crs:LocalExposure2012>
     <crs:CorrectionMasks>
      <rdf:Seq>
       <rdf:li rdf:parseType='Resource'>
        <crs:What>Mask/CircularGradient</crs:What>
        <crs:MaskValue>1.000000</crs:MaskValue>
        <crs:Angle>0.000000</crs:Angle>
        <crs:Top>0.100000</crs:Top>
        <crs:Left>0.100000</crs:Left>
        <crs:Bottom>0.900000</crs:Bottom>
        <crs:Right>0.900000</crs:Right>
        <crs:Feather>+100</crs:Feather>
       </rdf:li>
      </rdf:Seq>
     </crs:CorrectionMasks>
    </rdf:li>
   </rdf:Seq>
  </crs:CircularGradientBasedCorrections>
  <crs:PaintBasedCorrections>
   <rdf:Seq>
    <rdf:li>
     <rdf:Description
       crs:What="Correction"
       crs:CorrectionActive="true"
       crs:CorrectionAmount="1.000000"
       crs:LocalExposure2012="-0.069750"
       crs:LocalBrightness="0.000000">
     <crs:CorrectionMasks>
      <rdf:Seq>
       <rdf:li>
        <rdf:Description
          crs:What="Mask/Paint"
          crs:MaskValue="1.000000"
          crs:Radius="0.135597"
          crs:Flow="0.687000"
          crs:CenterWeight="0.000000">
        <crs:Dabs>
         <rdf:Seq>
          <rdf:li>d 0.610881 0.481687</rdf:li>
          <rdf:li>d 0.620105 0.534419</rdf:li>
          <rdf:li>d 0.625388 0.588143</rdf:li>
         </rdf:Seq>
        </crs:Dabs>
        </rdf:Description>
       </rdf:li>
       <rdf:li>
        <rdf:Description
          crs:What="Mask/Paint"
          crs:MaskValue="0.000000"
          crs:Radius="0.050000"
          crs:Flow="1.000000"
          crs:CenterWeight="0.000000">
        <crs:Dabs>
         <rdf:Seq>
          <rdf:li>d 0.620105 0.534419</rdf:li>
          <rdf:li>d 0.640000 0.534419</rdf:li>
         </rdf:Seq>
        </crs:Dabs>
        </rdf:Description>
       </rdf:li>
      </rdf:Seq>
     </crs:CorrectionMasks>
     </rdf:Description>
    </rdf:li>
   </rdf:Seq>
  </crs:PaintBasedCorrections>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

/**
 * A portrait shot of a camera that stores landscape pixels (6000 x 4000 sensor): a linear
 * gradient, a radial turned by 30° and a short brush stroke. `orientation` is the
 * tiff:Orientation Lightroom showed it with.
 */
export const orientedSidecar = (orientation: number) => `${head(`tiff:Orientation="${orientation}"
   crs:Version="17.0"
   crs:ProcessVersion="15.4"`)}
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true" crs:CorrectionName="Shapes" crs:LocalExposure2012="0.25">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li crs:What="Mask/Gradient" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskValue="1"
         crs:FullX="0.25" crs:FullY="0.5" crs:ZeroX="0.75" crs:ZeroY="0.5"/>
        <rdf:li crs:What="Mask/CircularGradient" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskValue="1"
         crs:Top="0.35" crs:Left="0.4" crs:Bottom="0.65" crs:Right="0.6" crs:Angle="30" crs:Feather="50" crs:Flipped="true" crs:Version="2"/>
        <rdf:li>
         <rdf:Description crs:What="Mask/Aggregate" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskValue="1">
         <crs:Masks>
          <rdf:Seq>
           <rdf:li>
            <rdf:Description crs:What="Mask/Paint" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskValue="1" crs:Radius="0.05" crs:Flow="1" crs:CenterWeight="0">
            <crs:Dabs><rdf:Seq><rdf:li>d 0.500000 0.500000</rdf:li><rdf:li>d 0.500000 0.600000</rdf:li></rdf:Seq></crs:Dabs>
            </rdf:Description>
           </rdf:li>
          </rdf:Seq>
         </crs:Masks>
         </rdf:Description>
        </rdf:li>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>${tail}`;

/** A preset with luminance range masks (after "Light Map", a real Lightroom 11 preset) and one radial. */
export const LUMINANCE_PRESET = `${head(`crs:PresetType="Normal"
   crs:UUID="0A1B2C3D4E5F60718293A4B5C6D7E8F9"
   crs:Version="14.5"
   crs:ProcessVersion="11.0"
   crs:HasSettings="True"`)}
   <crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Light Map</rdf:li></rdf:Alt></crs:Name>
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true" crs:CorrectionName="5 - Light" crs:LocalExposure2012="-0.1">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li>
         <rdf:Description crs:What="Mask/RangeMask" crs:MaskActive="true" crs:MaskName="Luminance Range 1" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskValue="1">
         <crs:CorrectionRangeMask crs:Version="3" crs:Type="2" crs:Invert="false" crs:SampleType="0"
          crs:LumRange="0.602343 0.801473 1.000000 1.000000" crs:LuminanceDepthSampleInfo="0 0.715133 0.459499"/>
         </rdf:Description>
        </rdf:li>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true" crs:CorrectionName="1 - Dark" crs:LocalShadows2012="0.2">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li>
         <rdf:Description crs:What="Mask/RangeMask" crs:MaskActive="true" crs:MaskName="Luminance Range 1" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskValue="1">
         <crs:CorrectionRangeMask crs:Version="3" crs:Type="2" crs:Invert="false" crs:SampleType="0"
          crs:LumRange="0.000000 0.000000 0.198525 0.403237" crs:LuminanceDepthSampleInfo="0 0.065166 0.155055"/>
         </rdf:Description>
        </rdf:li>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true" crs:CorrectionName="Corners" crs:LocalExposure2012="-0.125">
      <crs:CorrectionMasks>
       <rdf:Seq>
        <rdf:li crs:What="Mask/CircularGradient" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskInverted="true" crs:MaskValue="1"
         crs:Top="0.114613" crs:Left="0.079696" crs:Bottom="0.946729" crs:Right="0.933851" crs:Angle="0" crs:Feather="50" crs:Flipped="false" crs:Version="2"/>
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>${tail}`;

/** A sidecar with the given correction <rdf:li> items. */
export const withCorrections = (lis: string[]) => `${head('crs:Version="17.0" crs:ProcessVersion="15.4"')}
   <crs:MaskGroupBasedCorrections>
    <rdf:Seq>
${lis.join('\n')}
    </rdf:Seq>
   </crs:MaskGroupBasedCorrections>${tail}`;

/** One correction <rdf:li> with the given component <rdf:li> items. */
export const correction = (name: string, components: string[]) => `     <rdf:li>
      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="true" crs:CorrectionName="${name}" crs:LocalExposure2012="0.1">
      <crs:CorrectionMasks>
       <rdf:Seq>
${components.join('\n')}
       </rdf:Seq>
      </crs:CorrectionMasks>
      </rdf:Description>
     </rdf:li>`;

export const linearLi = (mode = 0) =>
  `        <rdf:li crs:What="Mask/Gradient" crs:MaskBlendMode="${mode}" crs:MaskInverted="false" crs:MaskValue="${mode ? 0 : 1}" crs:FullX="0.5" crs:FullY="0.1" crs:ZeroX="0.5" crs:ZeroY="0.4"/>`;

export const brushLi = (dabs: string[], mode = 0) => `        <rdf:li>
         <rdf:Description crs:What="Mask/Aggregate" crs:MaskActive="true" crs:MaskBlendMode="${mode}" crs:MaskInverted="false" crs:MaskValue="${mode ? 0 : 1}">
         <crs:Masks><rdf:Seq><rdf:li>
          <rdf:Description crs:What="Mask/Paint" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskValue="1" crs:Radius="0.02" crs:Flow="1" crs:CenterWeight="0">
          <crs:Dabs><rdf:Seq>${dabs.map((d) => `<rdf:li>${d}</rdf:li>`).join('')}</rdf:Seq></crs:Dabs>
          </rdf:Description>
         </rdf:li></rdf:Seq></crs:Masks>
         </rdf:Description>
        </rdf:li>`;

export const colorLi = (points: [number, number][]) => `        <rdf:li>
         <rdf:Description crs:What="Mask/RangeMask" crs:MaskActive="true" crs:MaskBlendMode="0" crs:MaskInverted="false" crs:MaskValue="1">
         <crs:CorrectionRangeMask>
          <rdf:Description crs:Version="3" crs:Type="1" crs:ColorAmount="0.79798" crs:Invert="false" crs:SampleType="0">
          <crs:PointModels><rdf:Seq>${points.map(([x, y], i) => `<rdf:li>0.5 0.5 0.5 ${x} ${y} ${i}</rdf:li>`).join('')}</rdf:Seq></crs:PointModels>
          </rdf:Description>
         </crs:CorrectionRangeMask>
         </rdf:Description>
        </rdf:li>`;
