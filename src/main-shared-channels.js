export function createSharedChannels(size) {
  const total = size * 2;
  const biomassBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const energyBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const geneBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const cellTypeBuffer = new SharedArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * total);
  const flowInBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const flowOutBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const flowVxBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const flowVyBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
  const biomassAll = new Float32Array(biomassBuffer);
  const energyAll = new Float32Array(energyBuffer);
  const geneAll = new Float32Array(geneBuffer);
  const cellTypeAll = new Uint8Array(cellTypeBuffer);
  const flowInAll = new Float32Array(flowInBuffer);
  const flowOutAll = new Float32Array(flowOutBuffer);
  const flowVxAll = new Float32Array(flowVxBuffer);
  const flowVyAll = new Float32Array(flowVyBuffer);
  const control = new Int32Array(controlBuffer);
  return {
    control,
    slots: [
      {
        biomass: biomassAll.subarray(0, size),
        energy: energyAll.subarray(0, size),
        gene: geneAll.subarray(0, size),
        cellType: cellTypeAll.subarray(0, size),
        flowIn: flowInAll.subarray(0, size),
        flowOut: flowOutAll.subarray(0, size),
        flowVx: flowVxAll.subarray(0, size),
        flowVy: flowVyAll.subarray(0, size)
      },
      {
        biomass: biomassAll.subarray(size, size * 2),
        energy: energyAll.subarray(size, size * 2),
        gene: geneAll.subarray(size, size * 2),
        cellType: cellTypeAll.subarray(size, size * 2),
        flowIn: flowInAll.subarray(size, size * 2),
        flowOut: flowOutAll.subarray(size, size * 2),
        flowVx: flowVxAll.subarray(size, size * 2),
        flowVy: flowVyAll.subarray(size, size * 2)
      }
    ],
    buffers: {
      control: controlBuffer,
      biomass: biomassBuffer,
      energy: energyBuffer,
      gene: geneBuffer,
      cellType: cellTypeBuffer,
      flowIn: flowInBuffer,
      flowOut: flowOutBuffer,
      flowVx: flowVxBuffer,
      flowVy: flowVyBuffer
    }
  };
}
