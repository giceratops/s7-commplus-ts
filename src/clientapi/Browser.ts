/*
 * S7CommPlusDriver - Copyright (C) 2023 Thomas Wiens, th.wiens@gmx.de (LGPL v3+)
 * Ported to TypeScript.
 */
import { Ids } from "../core/Ids.js";
import type { PObject } from "../core/PObject.js";
import type {
  IOffsetInfoType_1Dim,
  IOffsetInfoType_MDim,
  IOffsetInfoType_Relation,
  POffsetInfoType_Array1Dim,
  POffsetInfoType_ArrayMDim,
} from "../core/POffsetInfoType.js";
import type { ValueUDInt } from "../core/PValue.js";
import type { PVartypeListElement } from "../core/PVartypeList.js";
import { Softdatatype } from "../core/Softdatatype.js";

export const eNodeType = {
  Undefined: 0,
  Root: 1,
  Var: 2,
  Array: 3,
  StructArray: 4,
} as const;
export type eNodeType = (typeof eNodeType)[keyof typeof eNodeType];

export class VarInfo {
  name = "";
  accessSequence = "";
  softdatatype = 0;
  optAddress = 0; // Optimized access: Byte-Offset where the value is located when reading a complete DB content.
  optBitoffset = 0; // Optimized access: Bit-Offset where the value is located when reading a complete DB content.
  nonOptAddress = 0; // NonOptimized access: Byte-Offset where the value is located when reading a complete DB content.
  nonOptBitoffset = 0; // NonOptimized access: Bit-Offset where the value is located when reading a complete DB content.
}

class Node {
  nodeType: eNodeType = eNodeType.Undefined;
  name = "";
  accessId = 0;
  softdatatype = 0;
  relationId = 0;
  vte: PVartypeListElement | null = null;
  arrayAdrOffsetOpt = 0; // Offset of an Element when it's an array, optimized
  arrayAdrOffsetNonOpt = 0; // Offset of an Element when it's an array, not-optimized

  childs: Node[] = [];

  constructor(init?: Partial<Node>) {
    if (init) Object.assign(this, init);
  }
}

class VarRoot {
  nodes: Node[] = [];
}

const hex = (n: number): string => (n >>> 0).toString(16).toUpperCase();
const u32 = (n: number): number => n >>> 0;

export class Browser {
  private root: VarRoot;
  private objs: PObject[] = [];
  private varInfoList: VarInfo[] = [];

  constructor() {
    this.root = new VarRoot();
    this.root.nodes = [];
  }

  getVarInfoList(): VarInfo[] {
    return this.varInfoList;
  }

  setTypeInfoContainerObjects(objs: PObject[]): void {
    this.objs = objs;
  }

  addBlockNode(nodetype: eNodeType, name: string, accessid: number, tiRelId: number): void {
    const db = new Node({
      nodeType: nodetype,
      name: name,
      accessId: accessid,
      relationId: tiRelId,
    });
    this.root.nodes.push(db);
  }

  buildFlatList(): void {
    this.varInfoList = [];
    for (const node of this.root.nodes) {
      // Skip empty lists in any area like marker or timers.
      if (node.childs.length > 0) {
        const optOffset = 0;
        const nonOptOffset = 0;
        this.addFlatSubnodes(node, "", "", optOffset, nonOptOffset);
      }
    }
  }

  private addFlatSubnodes(node: Node, names: string, accessIds: string, optOffset: number, nonOptOffset: number): void {
    switch (node.nodeType) {
      case eNodeType.Root:
        names += node.name;
        accessIds += hex(node.accessId);
        break;
      case eNodeType.Array:
        names += node.name;
        accessIds += "." + hex(node.accessId);
        break;
      case eNodeType.StructArray:
        names += node.name;
        // TODO: Special: Between an array-index and the access-id is an additional 1. It's not known if it's a fixed or variable value.
        accessIds += "." + hex(node.accessId) + ".1";
        break;
      default:
        names += "." + node.name;
        accessIds += "." + hex(node.accessId);
        break;
    }

    if (node.childs.length === 0) {
      // We are at the leaf of our tree
      if (this.isSoftdatatypeSupported(node.softdatatype)) {
        const vte = node.vte!;
        const info = new VarInfo();
        info.name = names;
        info.accessSequence = accessIds;
        info.softdatatype = node.softdatatype;
        // If an Array element of basic datatype, the Vte is here from the parent array base element and offsets not valid here.
        if (node.nodeType === eNodeType.Array) {
          info.optAddress = optOffset;
          info.nonOptAddress = nonOptOffset;
        } else {
          info.optAddress = u32(optOffset + vte.offsetInfoType!.optimizedAddress);
          info.nonOptAddress = u32(nonOptOffset + vte.offsetInfoType!.nonoptimizedAddress);
        }
        // Special case #1:
        // There is a strange behaviour when transmitting bitoffsets in not-optmized DBs.
        // If a bool is inside a struct, the offsetinformation is in the attributes (last 3 bits.
        // Bitoffsetinfo bit classic is false in this case.
        // Don't know if this a bug in Plcsim (where I tested with) or intentional.
        //
        // Special case #2:
        // System datatypes like IEC_COUNTER, etc. have Bools with Bitoffsets, even when they are locates in optimized DBs.
        // The bitoffset is then located in the Attributes and not in the bitoffset
        if (node.softdatatype === Softdatatype.S7COMMP_SOFTDATATYPE_BOOL) {
          info.optBitoffset = vte.getAttributeBitoffset();
          if (vte.getBitoffsetinfoFlagClassic()) {
            info.nonOptBitoffset = vte.getBitoffsetinfoNonoptimizedBitoffset();
          } else {
            info.nonOptBitoffset = vte.getAttributeBitoffset();
          }
        } else if (node.softdatatype === Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL) {
          info.optBitoffset = vte.getBitoffsetinfoOptimizedBitoffset();
        } else {
          info.optBitoffset = 0;
          info.nonOptBitoffset = 0;
        }

        this.varInfoList.push(info);
      }
    } else {
      // root node (the DB itself) has no VarTypeListElement, but we don't need it here.
      if (node.vte != null) {
        const oit = node.vte.offsetInfoType!;
        switch (node.nodeType) {
          case eNodeType.Array:
            // This is an array element of basic datatype. Offset comes from fixed size multiplied by array index.
            optOffset = oit.optimizedAddress;
            nonOptOffset = oit.nonoptimizedAddress;
            break;
          case eNodeType.StructArray:
            optOffset = u32(optOffset + node.arrayAdrOffsetOpt);
            nonOptOffset = u32(nonOptOffset + node.arrayAdrOffsetNonOpt);
            break;
          default:
            optOffset = u32(optOffset + oit.optimizedAddress);
            nonOptOffset = u32(nonOptOffset + oit.nonoptimizedAddress);
            break;
        }
      }
      for (const sub of node.childs) {
        if (sub.nodeType === eNodeType.Array) {
          this.addFlatSubnodes(sub, names, accessIds, u32(optOffset + sub.arrayAdrOffsetOpt), u32(nonOptOffset + sub.arrayAdrOffsetNonOpt));
        } else {
          this.addFlatSubnodes(sub, names, accessIds, optOffset, nonOptOffset);
        }
      }
    }
  }

  buildTree(): void {
    for (let i = 0; i < this.root.nodes.length; i++) {
      for (const ob of this.objs) {
        if (ob.relationId === this.root.nodes[i].relationId) {
          const node = this.root.nodes[i];
          this.addSubNodes(node, ob);
          break;
        }
      }
    }
  }

  private addSubNodes(node: Node, o: PObject): void {
    let tComSize: number;

    let elementIndex = 0;

    // If there are no variables at all in an area, then this list does not exist (no error).
    if (o.vartypeList != null) {
      for (const vte of o.vartypeList.elements) {
        const oit = vte.offsetInfoType!;
        const subnode = new Node({
          name: o.varnameList!.names[elementIndex],
          softdatatype: vte.softdatatype,
          accessId: vte.lid,
          vte: vte,
        });

        node.childs.push(subnode);
        // Process arrays. TODO: Put the processing to separate methods, to shorten this method.
        if (oit.is1Dim()) {
          // #region Struct/UDT or flat arrays with one dimension
          const ioit = oit as unknown as IOffsetInfoType_1Dim;
          const arrayElementCount = ioit.getArrayElementCount();
          const arrayLowerBounds = ioit.getArrayLowerBounds();

          // The access-id always starts with 0, independent of lowerbounds
          for (let i = 0; i < arrayElementCount; i++) {
            // Handle Struct/FB Array separate: Has an additional ID between array index and access-LID.
            if (oit.hasRelation()) {
              const arraynode = new Node({
                nodeType: eNodeType.StructArray,
                name: "[" + (i + arrayLowerBounds) + "]",
                softdatatype: vte.softdatatype,
                accessId: i,
                vte: vte,
              });
              subnode.childs.push(arraynode);

              // All OffsetInfoTypes which occur at this point should have a Relation Id
              const ioit2 = oit as unknown as IOffsetInfoType_Relation;

              for (const ob of this.objs) {
                if (ob.relationId === ioit2.getRelationId()) {
                  // Get the size of a struct element
                  tComSize = (ob.getAttribute(Ids.TI_TComSize) as ValueUDInt).getValue();
                  arraynode.arrayAdrOffsetOpt = u32(i * tComSize);
                  arraynode.arrayAdrOffsetNonOpt = u32(i * tComSize);

                  this.addSubNodes(arraynode, ob);
                  break;
                }
              }
            } else {
              const arraynode = new Node({
                nodeType: eNodeType.Array,
                name: "[" + (i + arrayLowerBounds) + "]",
                softdatatype: vte.softdatatype,
                accessId: i,
                vte: vte,
              });
              // Get the size of the basic datatype
              tComSize = this.getSizeOfDatatype(vte);
              arraynode.arrayAdrOffsetOpt = u32(i * tComSize);
              arraynode.arrayAdrOffsetNonOpt = u32(i * tComSize);

              subnode.childs.push(arraynode);
            }
          }
          // #endregion
        } else if (oit.isMDim()) {
          // #region Struct/UDT or flat array with more than one dimension
          const ioit = oit as unknown as IOffsetInfoType_MDim;
          const arrayElementCount = ioit.getArrayElementCount();
          const mdimArrayElementCount = ioit.getMdimArrayElementCount();
          const mdimArrayLowerBounds = ioit.getMdimArrayLowerBounds();

          // Determine the actual number of dimensions
          let actdimensions = 0;
          for (let d = 0; d < 6; d++) {
            if (mdimArrayElementCount[d] > 0) {
              actdimensions++;
            }
          }

          let aname = "";
          let n = 1;
          let id = 0;
          const xx: number[] = [0, 0, 0, 0, 0, 0];
          do {
            aname = "[";
            for (let j = actdimensions - 1; j >= 0; j--) {
              aname += (u32(xx[j] + mdimArrayLowerBounds[j])).toString();
              if (j > 0) {
                aname += ",";
              } else {
                aname += "]";
              }
            }

            if (oit.hasRelation()) {
              const arraynode = new Node({
                nodeType: eNodeType.StructArray,
                name: aname,
                softdatatype: vte.softdatatype,
                accessId: id,
                vte: vte,
              });
              subnode.childs.push(arraynode);

              // All OffsetInfoTypes which occur at this point should have a Relation Id
              const ioit2 = oit as unknown as IOffsetInfoType_Relation;

              for (const ob of this.objs) {
                if (ob.relationId === ioit2.getRelationId()) {
                  // Get the size of a struct element
                  tComSize = (ob.getAttribute(Ids.TI_TComSize) as ValueUDInt).getValue();
                  arraynode.arrayAdrOffsetOpt = u32((n - 1) * tComSize);
                  arraynode.arrayAdrOffsetNonOpt = u32((n - 1) * tComSize);

                  this.addSubNodes(arraynode, ob);
                  break;
                }
              }
            } else {
              const arraynode = new Node({
                nodeType: eNodeType.Array,
                name: aname,
                softdatatype: vte.softdatatype,
                accessId: id,
                vte: vte,
              });
              tComSize = this.getSizeOfDatatype(vte);
              arraynode.arrayAdrOffsetOpt = u32((n - 1) * tComSize);
              arraynode.arrayAdrOffsetNonOpt = u32((n - 1) * tComSize);

              subnode.childs.push(arraynode);
            }
            xx[0]++;
            // BBOOL-Arrays on overflow the ID of the lowest array index goes only up to 8.
            if (subnode.softdatatype === Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL && xx[0] >= mdimArrayElementCount[0]) {
              if (mdimArrayElementCount[0] % 8 !== 0) {
                id += 8 - (xx[0] % 8);
              }
            }
            for (let dim = 0; dim < 5; dim++) {
              if (xx[dim] >= mdimArrayElementCount[dim]) {
                xx[dim] = 0;
                xx[dim + 1]++;
              }
            }
            id++;
            n++;
          } while (n <= arrayElementCount);
          // #endregion
        } else if (oit.hasRelation()) {
          // #region Struct / UDT / system library types (DTL, IEC_TIMER, ...) but not an array ...
          const ioit = oit as unknown as IOffsetInfoType_Relation;

          for (const ob of this.objs) {
            if (ob.relationId === ioit.getRelationId()) {
              this.addSubNodes(subnode, ob);
              break;
            }
          }
          // Empty areas are allowed, so don't return this as an error.
          // #endregion
        }
        elementIndex++;
      }
    }
  }

  private getSizeOfDatatype(vte: PVartypeListElement): number {
    // Returns the size of an element if stored as an array
    switch (vte.softdatatype) {
      case Softdatatype.S7COMMP_SOFTDATATYPE_STRING:
      case Softdatatype.S7COMMP_SOFTDATATYPE_WSTRING:
        // TODO:
        // If an array of String or WString, offsetinfo1 is the string length.
        // First though was, that offsetinfo2 is length including header of 2 bytes.
        // but with an Multidim Array [0..2, 0..1] of String[5] offsetinfo is 8, which is not
        // correct when you look at the data.
        // Tested only with Plcsim, which may be a bug in Plcsim?
        if (vte.offsetInfoType!.is1Dim()) {
          return u32((vte.offsetInfoType as POffsetInfoType_Array1Dim).unspecifiedOffsetinfo1 + 2);
        } else {
          return u32((vte.offsetInfoType as POffsetInfoType_ArrayMDim).unspecifiedOffsetinfo1 + 2);
        }
      case Softdatatype.S7COMMP_SOFTDATATYPE_AOMAID:
      case Softdatatype.S7COMMP_SOFTDATATYPE_AOMLINK:
        // TODO: Not possible to define this type
        return 0;
      case Softdatatype.S7COMMP_SOFTDATATYPE_BOOL:
      case Softdatatype.S7COMMP_SOFTDATATYPE_BYTE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_CHAR:
      case Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL:
      case Softdatatype.S7COMMP_SOFTDATATYPE_USINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_SINT:
        return 1;
      case Softdatatype.S7COMMP_SOFTDATATYPE_WORD:
      case Softdatatype.S7COMMP_SOFTDATATYPE_INT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_DATE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_S5TIME:
      case Softdatatype.S7COMMP_SOFTDATATYPE_BLOCKFB:
      case Softdatatype.S7COMMP_SOFTDATATYPE_BLOCKFC:
      case Softdatatype.S7COMMP_SOFTDATATYPE_COUNTER:
      case Softdatatype.S7COMMP_SOFTDATATYPE_TIMER:
      case Softdatatype.S7COMMP_SOFTDATATYPE_UINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_WCHAR:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWANY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWIOSYSTEM:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWDPMASTER:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWDEVICE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWDPSLAVE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWIO:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWMODULE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWSUBMODULE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWHSC:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWPWM:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWPTO:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWINTERFACE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_HWIEPORT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBANY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBDELAY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBTOD:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBCYCLIC:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBATT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_CONNANY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_CONNPRG:
      case Softdatatype.S7COMMP_SOFTDATATYPE_CONNOUC:
      case Softdatatype.S7COMMP_SOFTDATATYPE_PORT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_RTM:
      case Softdatatype.S7COMMP_SOFTDATATYPE_PIP:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBPCYCLE:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBHWINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBDIAG:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBTIMEERROR:
      case Softdatatype.S7COMMP_SOFTDATATYPE_OBSTARTUP:
      case Softdatatype.S7COMMP_SOFTDATATYPE_DBANY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_DBWWW:
      case Softdatatype.S7COMMP_SOFTDATATYPE_DBDYN:
        return 2;
      case Softdatatype.S7COMMP_SOFTDATATYPE_DWORD:
      case Softdatatype.S7COMMP_SOFTDATATYPE_DINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_REAL:
      case Softdatatype.S7COMMP_SOFTDATATYPE_TIMEOFDAY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_TIME:
      case Softdatatype.S7COMMP_SOFTDATATYPE_UDINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_AOMIDENT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_EVENTANY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_EVENTATT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_EVENTHWINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_CONNRID:
        return 4;
      case Softdatatype.S7COMMP_SOFTDATATYPE_POINTER:
        return 6;
      case Softdatatype.S7COMMP_SOFTDATATYPE_DATEANDTIME:
      case Softdatatype.S7COMMP_SOFTDATATYPE_LREAL:
      case Softdatatype.S7COMMP_SOFTDATATYPE_ULINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_LINT:
      case Softdatatype.S7COMMP_SOFTDATATYPE_LWORD:
      case Softdatatype.S7COMMP_SOFTDATATYPE_LTIME:
      case Softdatatype.S7COMMP_SOFTDATATYPE_LTOD:
      case Softdatatype.S7COMMP_SOFTDATATYPE_LDT:
        return 8;
      case Softdatatype.S7COMMP_SOFTDATATYPE_ANY:
      case Softdatatype.S7COMMP_SOFTDATATYPE_REMOTE:
        return 10;
      case Softdatatype.S7COMMP_SOFTDATATYPE_DTL:
        return 12;
      default:
        return 0;
    }
  }

  private isSoftdatatypeSupported(softdatatype: number): boolean {
    return supportedSoftdatatypes.has(softdatatype);
  }
}

const supportedSoftdatatypes: ReadonlySet<number> = new Set<number>([
  Softdatatype.S7COMMP_SOFTDATATYPE_BOOL,
  Softdatatype.S7COMMP_SOFTDATATYPE_BYTE,
  Softdatatype.S7COMMP_SOFTDATATYPE_CHAR,
  Softdatatype.S7COMMP_SOFTDATATYPE_BBOOL,
  Softdatatype.S7COMMP_SOFTDATATYPE_USINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_SINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_WORD,
  Softdatatype.S7COMMP_SOFTDATATYPE_INT,
  Softdatatype.S7COMMP_SOFTDATATYPE_DATE,
  Softdatatype.S7COMMP_SOFTDATATYPE_S5TIME,
  Softdatatype.S7COMMP_SOFTDATATYPE_BLOCKFB,
  Softdatatype.S7COMMP_SOFTDATATYPE_BLOCKFC,
  Softdatatype.S7COMMP_SOFTDATATYPE_COUNTER,
  Softdatatype.S7COMMP_SOFTDATATYPE_TIMER,
  Softdatatype.S7COMMP_SOFTDATATYPE_UINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_WCHAR,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWANY,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWIOSYSTEM,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWDPMASTER,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWDEVICE,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWDPSLAVE,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWIO,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWMODULE,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWSUBMODULE,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWHSC,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWPWM,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWPTO,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWINTERFACE,
  Softdatatype.S7COMMP_SOFTDATATYPE_HWIEPORT,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBANY,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBDELAY,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBTOD,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBCYCLIC,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBATT,
  Softdatatype.S7COMMP_SOFTDATATYPE_CONNANY,
  Softdatatype.S7COMMP_SOFTDATATYPE_CONNPRG,
  Softdatatype.S7COMMP_SOFTDATATYPE_CONNOUC,
  Softdatatype.S7COMMP_SOFTDATATYPE_PORT,
  Softdatatype.S7COMMP_SOFTDATATYPE_RTM,
  Softdatatype.S7COMMP_SOFTDATATYPE_PIP,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBPCYCLE,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBHWINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBDIAG,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBTIMEERROR,
  Softdatatype.S7COMMP_SOFTDATATYPE_OBSTARTUP,
  Softdatatype.S7COMMP_SOFTDATATYPE_DBANY,
  Softdatatype.S7COMMP_SOFTDATATYPE_DBWWW,
  Softdatatype.S7COMMP_SOFTDATATYPE_DBDYN,
  Softdatatype.S7COMMP_SOFTDATATYPE_DWORD,
  Softdatatype.S7COMMP_SOFTDATATYPE_DINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_REAL,
  Softdatatype.S7COMMP_SOFTDATATYPE_TIMEOFDAY,
  Softdatatype.S7COMMP_SOFTDATATYPE_TIME,
  Softdatatype.S7COMMP_SOFTDATATYPE_UDINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_AOMIDENT,
  Softdatatype.S7COMMP_SOFTDATATYPE_EVENTANY,
  Softdatatype.S7COMMP_SOFTDATATYPE_EVENTATT,
  Softdatatype.S7COMMP_SOFTDATATYPE_EVENTHWINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_CONNRID,
  Softdatatype.S7COMMP_SOFTDATATYPE_DATEANDTIME,
  Softdatatype.S7COMMP_SOFTDATATYPE_LREAL,
  Softdatatype.S7COMMP_SOFTDATATYPE_ULINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_LINT,
  Softdatatype.S7COMMP_SOFTDATATYPE_LWORD,
  Softdatatype.S7COMMP_SOFTDATATYPE_LTIME,
  Softdatatype.S7COMMP_SOFTDATATYPE_LTOD,
  Softdatatype.S7COMMP_SOFTDATATYPE_LDT,
  Softdatatype.S7COMMP_SOFTDATATYPE_POINTER,
  Softdatatype.S7COMMP_SOFTDATATYPE_ANY,
  Softdatatype.S7COMMP_SOFTDATATYPE_REMOTE,
  Softdatatype.S7COMMP_SOFTDATATYPE_DTL,
  Softdatatype.S7COMMP_SOFTDATATYPE_AOMAID,
  Softdatatype.S7COMMP_SOFTDATATYPE_AOMLINK,
  Softdatatype.S7COMMP_SOFTDATATYPE_STRING,
  Softdatatype.S7COMMP_SOFTDATATYPE_WSTRING,
]);
