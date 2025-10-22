export interface EndpointData {
  vlan: string;
  ip: string;
  paths: string[];
  pod: string;
}

export interface PathAttachment {
  vlan: string;
  epg: string;
  path: string;
  fullPath: string;
}

export interface ValidationResult {
  path: string;
  hasActiveEndpoint: boolean;
  isVlanAllowed: boolean;
  status: 'allowed' | 'not_allowed';
}

export function parseEndpointOutput(input: string): EndpointData | null {
  const lines = input.trim().split('\n');

  let vlan = '';
  let pod = '';
  const pathSet = new Set<string>();

  for (const line of lines) {
    const vlanMatch = line.match(/vlan-(\d+)/i);
    if (vlanMatch) {
      vlan = vlanMatch[1];
    }

    const nodeMatch = line.match(/Node\s*\n\s*(\d+)\s+(\d+)/);
    if (nodeMatch) {
      const node1 = parseInt(nodeMatch[1]);
      if (node1 >= 400) {
        pod = 'pod-2';
      } else if (node1 >= 300) {
        pod = 'pod-1';
      }
    }

    const vpcMatch = line.match(/vpc\s+([\d-]+-VPC-[\d-]+-PG)/i);
    if (vpcMatch) {
      pathSet.add(vpcMatch[1]);
    }
  }

  if (vlan && pathSet.size > 0) {
    return {
      vlan,
      ip: '',
      paths: Array.from(pathSet),
      pod: pod || 'pod-1'
    };
  }

  return null;
}

export function parseMoqueryOutput(input: string): PathAttachment[] {
  const lines = input.trim().split('\n');
  const attachments: PathAttachment[] = [];

  for (const line of lines) {
    // Match protpaths (VPC)
    let dnMatch = line.match(/dn\s*:\s*uni\/tn-[^\/]+\/ap-[^\/]+\/epg-([^\/]+)\/rspathAtt-\[topology\/(pod-\d+\/protpaths-[\d-]+\/pathep-\[[^\]]+\])\]/i);

    // Match single paths (non-VPC)
    if (!dnMatch) {
      dnMatch = line.match(/dn\s*:\s*uni\/tn-[^\/]+\/ap-[^\/]+\/epg-([^\/]+)\/rspathAtt-\[topology\/(pod-\d+\/paths-[\d]+\/pathep-\[[^\]]+\])\]/i);
    }

    if (dnMatch) {
      const epg = dnMatch[1];
      const fullPath = dnMatch[2];

      const vlanMatch = epg.match(/VLAN(\d+)/i);
      const vlan = vlanMatch ? vlanMatch[1] : '';

      const pathMatch = fullPath.match(/pathep-\[([^\]]+)\]/);
      const pathName = pathMatch ? pathMatch[1] : '';

      if (vlan && pathName) {
        attachments.push({
          vlan,
          epg,
          path: pathName,
          fullPath
        });
      }
    }
  }

  return attachments;
}

export function validateVlanAllowances(
  endpointData: EndpointData,
  pathAttachments: PathAttachment[]
): ValidationResult[] {
  const results: ValidationResult[] = [];

  // Create a map of path -> pod from moquery data
  const pathPodMap = new Map<string, string>();
  for (const att of pathAttachments) {
    const podMatch = att.fullPath.match(/^(pod-\d+)\//);
    if (podMatch) {
      pathPodMap.set(att.path, podMatch[1]);
    }
  }

  // Filter allowed paths by matching both VLAN and pod
  const allowedPathsSet = new Set(
    pathAttachments
      .filter(att => {
        if (att.vlan !== endpointData.vlan) return false;

        const attPod = att.fullPath.match(/^(pod-\d+)\//)?.[1];
        return attPod === endpointData.pod;
      })
      .map(att => att.path)
  );

  for (const path of endpointData.paths) {
    const isAllowed = allowedPathsSet.has(path);

    results.push({
      path,
      hasActiveEndpoint: true,
      isVlanAllowed: isAllowed,
      status: isAllowed ? 'allowed' : 'not_allowed'
    });
  }

  return results;
}

export function generateCSV(
  vlan: string,
  epg: string,
  results: ValidationResult[],
  endpointData: EndpointData,
  pathAttachments: PathAttachment[]
): string {
  const header = 'VLAN,EPG,PATH';

  const notAllowedPaths = results
    .filter(r => r.status === 'not_allowed')
    .map(r => r.path);

  // Build a map of path to full path from moquery data for correct pod info
  const pathMap = new Map<string, string>();
  for (const attachment of pathAttachments) {
    pathMap.set(attachment.path, attachment.fullPath);
  }

  const rows = notAllowedPaths.map(vpcPath => {
    // Try to find matching path from moquery data with same pod
    let fullPath = '';

    // First, look for exact path match in moquery with matching vlan (to get correct pod)
    for (const attachment of pathAttachments) {
      if (attachment.path === vpcPath) {
        // Extract pod from attachment
        const podMatch = attachment.fullPath.match(/^(pod-\d+)\//);
        if (podMatch) {
          const attachmentPod = podMatch[1];
          // Use this path if pod matches endpoint pod
          if (attachmentPod === endpointData.pod) {
            fullPath = attachment.fullPath;
            break;
          }
        }
      }
    }

    // If not found in moquery, construct path using endpoint pod
    if (!fullPath) {
      const protpathsMatch = vpcPath.match(/(\d+)-(\d+)-VPC/);
      if (protpathsMatch) {
        fullPath = `${endpointData.pod}/protpaths-${protpathsMatch[1]}-${protpathsMatch[2]}/pathep-[${vpcPath}]`;
      } else {
        fullPath = `${endpointData.pod}/paths-XXX/pathep-[${vpcPath}]`;
      }
    }

    return `${vlan},${epg},${fullPath}`;
  });

  return header + '\n' + rows.join('\n');
}

export function extractPathName(path: string): string {
  return path;
}

export function extractVlanFromEpg(epgName: string): string {
  const vlanMatch = epgName.match(/VLAN(\d+)/i);
  return vlanMatch ? vlanMatch[1] : '';
}
