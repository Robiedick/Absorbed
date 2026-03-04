# Planet 3D Models

Drop your `.glb` (GLTF Binary) or `.gltf` planet models into this folder.

## Naming Convention

Name your files after the planet type they should replace:

| Filename              | Planet Type     |
|-----------------------|-----------------|
| `rocky.glb/.gltf`     | Rocky planet    |
| `gas.glb/.gltf`       | Gas giant       |
| `ocean.glb/.gltf`     | Ocean planet    |
| `ice.glb/.gltf`       | Ice planet      |
| `volcanic.glb/.gltf`  | Volcanic planet |
| `crystal.glb/.gltf`   | Crystal planet  |

## Variants

You can also add **numbered variants** for variety — the game will pick one randomly per planet instance:

```
rocky_1.glb
rocky_2.gltf
rocky_3.glb
gas_1.gltf
gas_2.glb
```

## Notes

- Models should be **centred at the origin** and fit within a **~2-unit bounding box**.
- The game auto-scales models to fit, so exact size doesn't matter.
- **GLTF embedded textures** are supported (PBR materials work great).
- If no model is found for a type, the game falls back to a procedural 2D planet.
- Recommended poly count: **under 50k triangles** for smooth performance with 8 planets.

## Where to get models

Good free sources:
- [Sketchfab](https://sketchfab.com) (search "planet", filter by license)
- [Poly Pizza](https://poly.pizza)
- [NASA 3D Resources](https://nasa3d.arc.nasa.gov/models)
- [KenShape](https://kenney.nl/tools/kenshape) for stylised low-poly
