export interface CloudflareVisualModel {
  id: string;
  label: string;
  task: "image" | "video";
  description: string;
  experimental?: boolean;
}

export interface CloudflareVisualCatalog {
  provider: "cloudflare";
  image_models: CloudflareVisualModel[];
  video_models: CloudflareVisualModel[];
  image_model_count: number;
  video_model_count: number;
  source: "cloudflare_account_catalog_and_official_docs";
}

const IMAGE_MODELS: CloudflareVisualModel[] = [
  {
    id: "@cf/black-forest-labs/flux-2-klein-9b",
    label: "FLUX.2 Klein 9B",
    task: "image",
    description: "Text-to-image generation with multi-reference editing support.",
  },
  {
    id: "@cf/runwayml/stable-diffusion-v1-5-inpainting",
    label: "Stable Diffusion v1.5 Inpainting",
    task: "image",
    description: "Text-to-image generation and masked inpainting.",
    experimental: true,
  },
  {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 Schnell",
    task: "image",
    description: "Fast text-to-image generation.",
  },
  {
    id: "@cf/bytedance/stable-diffusion-xl-lightning",
    label: "SDXL Lightning",
    task: "image",
    description: "Fast 1024px text-to-image generation.",
    experimental: true,
  },
  {
    id: "@cf/lykon/dreamshaper-8-lcm",
    label: "DreamShaper 8 LCM",
    task: "image",
    description: "Stable Diffusion model tuned for photorealistic image generation.",
  },
  {
    id: "@cf/leonardo/phoenix-1.0",
    label: "Leonardo Phoenix 1.0",
    task: "image",
    description: "Prompt-responsive image generation with coherent text rendering.",
  },
  {
    id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL Base 1.0",
    task: "image",
    description: "Text-to-image generation and image modification.",
    experimental: true,
  },
  {
    id: "@cf/black-forest-labs/flux-2-klein-4b",
    label: "FLUX.2 Klein 4B",
    task: "image",
    description: "Fast image generation and editing for interactive workflows.",
  },
  {
    id: "@cf/black-forest-labs/flux-2-dev",
    label: "FLUX.2 Dev",
    task: "image",
    description: "Detailed image generation with multi-reference support.",
  },
  {
    id: "@cf/runwayml/stable-diffusion-v1-5-img2img",
    label: "Stable Diffusion v1.5 Img2Img",
    task: "image",
    description: "Image-to-image transformation with Stable Diffusion.",
    experimental: true,
  },
  {
    id: "@cf/leonardo/lucid-origin",
    label: "Leonardo Lucid Origin",
    task: "image",
    description: "Prompt-responsive image generation for graphic, product, and concept visuals.",
  },
];

const VIDEO_MODELS: CloudflareVisualModel[] = [
  {
    id: "bytedance/seedance-2.0",
    label: "Seedance 2.0",
    task: "video",
    description: "Multimodal text-to-video generation with 4–12 second scene clips.",
  },
  {
    id: "xai/grok-imagine-video",
    label: "Grok Imagine Video",
    task: "video",
    description: "Text/image-to-video generation, editing, and extension with synchronized audio support.",
  },
];

export function getCloudflareVisualCatalog(): CloudflareVisualCatalog {
  return {
    provider: "cloudflare",
    image_models: IMAGE_MODELS,
    video_models: VIDEO_MODELS,
    image_model_count: IMAGE_MODELS.length,
    video_model_count: VIDEO_MODELS.length,
    source: "cloudflare_account_catalog_and_official_docs",
  };
}

export function isCloudflareImageModel(value: unknown): boolean {
  const id = String(value || "").trim();
  return IMAGE_MODELS.some((model) => model.id === id);
}

export function isCloudflareVideoModel(value: unknown): boolean {
  const id = String(value || "").trim();
  return VIDEO_MODELS.some((model) => model.id === id);
}

export function resolveCloudflareVideoModel(value: unknown): string {
  const id = String(value || "").trim();
  return isCloudflareVideoModel(id) ? id : VIDEO_MODELS[0].id;
}

export function resolveCloudflareImageModel(value: unknown): string {
  const id = String(value || "").trim();
  return isCloudflareImageModel(id) ? id : IMAGE_MODELS[0].id;
}
