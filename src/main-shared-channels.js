export function createSharedChannels(size) {
  const total = size * 2;
  const biomassBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const energyBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const geneBuffer = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * total);
  const cellTypeBuffer = new SharedArrayBuffer(Uint8Array.BYTES_PER_ELEMENT * total);
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
  const biomassAll = new Float32Array(biomassBuffer);
  const energyAll = new Float32Array(energyBuffer);
  const geneAll = new Float32Array(geneBuffer);
  const cellTypeAll = new Uint8Array(cellTypeBuffer);
  const control = new Int32Array(controlBuffer);
  return {
    control,
    slots: [
      {
        biomass: biomassAll.subarray(0, size),
        energy: energyAll.subarray(0, size),
        gene: geneAll.subarray(0, size),
        cellType: cellTypeAll.subarray(0, size)
      },
      {
        biomass: biomassAll.subarray(size, size * 2),
        energy: energyAll.subarray(size, size * 2),
        gene: geneAll.subarray(size, size * 2),
        cellType: cellTypeAll.subarray(size, size * 2)
      }
    ],
    buffers: {
      control: controlBuffer,
      biomass: biomassBuffer,
      energy: energyBuffer,
      gene: geneBuffer,
      cellType: cellTypeBuffer
    }
  };
}
