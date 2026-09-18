/* Part of V3Code, distributed by KandD Labs LLC.
 * Existing copyright and license notices remain applicable.
 */
/*--------------------------------------------------------------------------------------
 *  V3Code — Ambient shader background
 *  GPU-accelerated atmosphere: deep void + restrained amethyst bloom
 *--------------------------------------------------------------------------------------*/

import {
  Shader,
  SolidColor,
  Swirl,
} from 'shaders/react'

export default function V3CodeShader() {
  return (
    <Shader className="absolute inset-0 -z-10">
      {/* Near-black void. Almost no color — the accents pop because
          everything else is committed to the dark. */}
      <SolidColor color="#000000" />
      <Swirl
        blend={7}
        colorA="#15131f"
        colorB="#000000"
        colorSpace="oklab"
        detail={2.2}
        speed={0.012}
      />
    </Shader>
  )
}
