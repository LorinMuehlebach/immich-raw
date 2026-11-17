// A trimmed Lightroom (cloud) sidecar for a landscape Fujifilm RAF, as Lightroom writes it next
// to the file. What matters here: white balance is "As Shot" with no Temperature/Tint, the camera's
// default profile sits in the crd: namespace (Provia) while the profile in use is the "Adobe Color"
// Look, which carries its own tone curve inside crs:Look. Serial numbers and ids are removed.
export const LR_CC_FUJI_SIDECAR = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:crd="http://ns.adobe.com/camera-raw-defaults/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:CreatorTool="Digital Camera X-T30 Ver2.01"
   tiff:Make="FUJIFILM"
   tiff:Model="X-T30"
   tiff:Orientation="1"
   tiff:ImageWidth="6240"
   tiff:ImageLength="4160"
   photoshop:SidecarForExtension="RAF"
   dc:format="image/x-fuji-raw"
   crd:CameraProfile="Camera PROVIA/Standard"
   crd:LookName=""
   crs:Version="18.5"
   crs:ProcessVersion="15.4"
   crs:WhiteBalance="As Shot"
   crs:Exposure2012="+1.27"
   crs:Contrast2012="+7"
   crs:Highlights2012="-63"
   crs:Shadows2012="+58"
   crs:Whites2012="+32"
   crs:Blacks2012="-23"
   crs:Texture="0"
   crs:Clarity2012="0"
   crs:Dehaze="0"
   crs:Vibrance="+15"
   crs:Saturation="+1"
   crs:Sharpness="40"
   crs:ToneCurveName2012="Linear"
   crs:CameraProfile="Adobe Standard"
   crs:CameraProfileDigest="E18D294B5AF2850F60D3BB80427F1AF3"
   crs:HasSettings="True"
   crs:CropTop="0"
   crs:CropLeft="0.041476"
   crs:CropBottom="0.86284"
   crs:CropRight="0.904316"
   crs:CropAngle="0"
   crs:HasCrop="True"
   crs:AlreadyApplied="False">
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
   <crs:Look>
    <rdf:Description
     crs:Name="Adobe Color"
     crs:Amount="1"
     crs:UUID="B952C231111CD8E0ECCF14B86BAA7077"
     crs:SupportsAmount="false"
     crs:SupportsMonochrome="false"
     crs:SupportsOutputReferred="false"
     crs:Copyright="© 2018 Adobe Systems, Inc.">
    <crs:Group>
     <rdf:Alt>
      <rdf:li xml:lang="x-default">Profiles</rdf:li>
     </rdf:Alt>
    </crs:Group>
    <crs:Parameters>
     <rdf:Description
      crs:Version="18.5"
      crs:ProcessVersion="15.4"
      crs:ConvertToGrayscale="False"
      crs:CameraProfile="Adobe Standard"
      crs:LookTable="E1095149FDB39D7A057BAB208837E2E1">
     <crs:ToneCurvePV2012>
      <rdf:Seq>
       <rdf:li>0, 0</rdf:li>
       <rdf:li>22, 16</rdf:li>
       <rdf:li>40, 35</rdf:li>
       <rdf:li>127, 127</rdf:li>
       <rdf:li>224, 230</rdf:li>
       <rdf:li>240, 246</rdf:li>
       <rdf:li>255, 255</rdf:li>
      </rdf:Seq>
     </crs:ToneCurvePV2012>
     </rdf:Description>
    </crs:Parameters>
    </rdf:Description>
   </crs:Look>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;
