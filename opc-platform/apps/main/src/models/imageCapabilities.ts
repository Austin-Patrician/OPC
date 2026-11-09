import type { ImageModelCapabilities, ImageParameterName, ImageParameterSpec, ModelOption } from '@opc/shared/domain';

const enumParameter = (values: string[], description: string): ImageParameterSpec => ({
  type: 'enum',
  values,
  description,
});

/** Conservative protocol profiles used when a catalog entry has no model override. */
const PROTOCOL_CAPABILITIES: Record<string, ImageModelCapabilities> = {
  'openai-images': {
    parameters: {
      size: enumParameter(['1024x1024', '1536x1024', '1024x1536'], 'Output dimensions.'),
      quality: enumParameter(['auto', 'low', 'medium', 'high'], 'Image quality / compute level.'),
      style: enumParameter(['vivid', 'natural'], 'Visual style, when supported by the model.'),
      background: enumParameter(['auto', 'opaque', 'transparent'], 'Background treatment.'),
      output_format: enumParameter(['png', 'jpeg', 'webp'], 'Output image format.'),
    },
  },
  'google-images': {
    parameters: {
      aspect_ratio: enumParameter(
        ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
        'Output aspect ratio.',
      ),
      size: enumParameter(['1K', '2K', '4K'], 'Output resolution tier.'),
    },
  },
  // OpenRouter relays several vendors with incompatible option shapes. Until a
  // catalog entry declares a model-specific mapping, expose prompt only.
  'openrouter-images': { parameters: {} },
};

const OPENAI_IMAGE_CAPABILITIES: ImageModelCapabilities = {
  parameters: {
    size: enumParameter(['1024x1024', '1536x1024', '1024x1536'], 'Output dimensions.'),
    quality: enumParameter(['auto', 'low', 'medium', 'high'], 'Image quality / compute level.'),
    background: enumParameter(['auto', 'opaque', 'transparent'], 'Background treatment.'),
    output_format: enumParameter(['png', 'jpeg', 'webp'], 'Output image format.'),
  },
};

const GOOGLE_IMAGE_CAPABILITIES: ImageModelCapabilities = {
  parameters: {
    aspect_ratio: enumParameter(
      ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
      'Output aspect ratio.',
    ),
    size: enumParameter(['1K', '2K', '4K'], 'Output resolution tier.'),
  },
};

const clone = (capabilities: ImageModelCapabilities): ImageModelCapabilities => ({
  parameters: Object.fromEntries(
    Object.entries(capabilities.parameters).map(([name, spec]) => [name, { ...spec, values: spec.values?.slice() }]),
  ) as Partial<Record<ImageParameterName, ImageParameterSpec>>,
});

/** Returns the model override, or a conservative protocol profile. */
export function imageCapabilitiesForModel(model: Pick<ModelOption, 'api' | 'imageParameters'>): ImageModelCapabilities {
  if (model.imageParameters) return clone(model.imageParameters);
  return clone(PROTOCOL_CAPABILITIES[model.api ?? 'openai-images'] ?? PROTOCOL_CAPABILITIES['openai-images']!);
}

export function imageCapabilitiesForProtocol(protocol: string): ImageModelCapabilities {
  return clone(PROTOCOL_CAPABILITIES[protocol] ?? PROTOCOL_CAPABILITIES['openai-images']!);
}

export const KNOWN_IMAGE_MODEL_CAPABILITIES: Record<string, ImageModelCapabilities> = {
  'openai-images': clone(OPENAI_IMAGE_CAPABILITIES),
  'google-images': clone(GOOGLE_IMAGE_CAPABILITIES),
};

export function isImageParameterSupported(
  capabilities: ImageModelCapabilities,
  name: ImageParameterName,
): boolean {
  return Boolean(capabilities.parameters[name]);
}

