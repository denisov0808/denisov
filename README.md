<xml xmlns="http://www.w3.org/1999/xhtml" collection="false">
  <!-- ... existing variables ... -->

  <!-- Add new variables for moving average watch and contract -->
  <variable type="" id="j#_;dg!l;aG,Sj`XDoL7">MovingAverageWatch</variable>
  <variable type="" id="T|4x!$@qDzC2Yg:!Z,Dp">BuyContract</variable>
  <variable type="" id="BX%y^Xb!bS;uJ%L)5]Pd">SellContract</variable>

  <!-- ... existing variables ... -->

  <!-- Add logic for moving average watch and contracts -->
  <block type="controls_if" id="L}o^k^*A+RZ`|TtZP2^2">
    <mutation else="1" elseif="1" />
    <value name="IF0">
      <block type="logic_compare" id="`#8sTl}hc|p%LmeBo{KZ">
        <field name="OP">EQ</field>
        <value name="A">
          <block type="variables_get" id="g@b-_`kP-G.~c78#nbs)">
            <field name="VAR" id="9dzem05%Tg3eTO3]E,at">_Period</field>
          </block>
        </value>
        <value name="B">
          <block type="variables_get" id="d9o;Bv-!#p-|^bB1ylU|">
            <field name="VAR" id="j#_;dg!l;aG,Sj`XDoL7">MovingAverageWatch</field>
          </block>
        </value>
      </block>
    </value>
    <statement name="DO0">
      <block type="variables_set" id="MS@{cMeyzS|;q!;zjc75">
        <field name="VAR" id="T|4x!$@qDzC2Yg:!Z,Dp">BuyContract</field>
        <value name="VALUE">
          <block type="logic_boolean" id="4]*q#l4Edk!#lV#_NiWB">
            <field name="BOOL">TRUE</field>
          </block>
        </value>
      </block>
    </statement>
    <statement name="ELSE">
      <block type="variables_set" id="C1GJv^X@2~C5Iia=ApW@">
        <field name="VAR" id="T|4x!$@qDzC2Yg:!Z,Dp">BuyContract</field>
        <value name="VALUE">
          <block type="logic_boolean" id="}z0OZLf=l|Wz*#l^`W-7">
            <field name="BOOL">FALSE</field>
          </block>
        </value>
      </block>
    </statement>
    <!-- Add similar logic for SellContract if needed -->
  </block>

  <!-- ... existing script ... -->
</xml>
