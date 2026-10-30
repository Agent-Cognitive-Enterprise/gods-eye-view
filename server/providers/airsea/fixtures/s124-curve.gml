<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<S124:Dataset xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:S124="http://www.iho.int/S124/gml/2.0" xmlns:S100="http://www.iho.int/s100gml/5.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xlink="http://www.w3.org/1999/xlink" gml:id="CCG.S124.CA01.C.0031.26" xsi:schemaLocation="http://www.iho.int/S124/gml/2.0 https://schemas.s100dev.net/schemas/S124/2.0.0/20250728/124_2.0.0.xsd">
    <gml:boundedBy>
        <gml:Envelope srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
            <gml:lowerCorner>45.293549 -73.250278</gml:lowerCorner>
            <gml:upperCorner>45.299954 -73.250175</gml:upperCorner>
        </gml:Envelope>
    </gml:boundedBy>
    <S100:DatasetIdentificationInformation>
        <S100:encodingSpecification>S-100 Part 10b</S100:encodingSpecification>
        <S100:encodingSpecificationEdition>1.0</S100:encodingSpecificationEdition>
        <S100:productIdentifier>S-124</S100:productIdentifier>
        <S100:productEdition>2.0.0</S100:productEdition>
        <S100:applicationProfile>1</S100:applicationProfile>
        <S100:datasetFileIdentifier>124CA01C_0031_26.GML</S100:datasetFileIdentifier>
        <S100:datasetTitle>Marine Works - Construction operations</S100:datasetTitle>
        <S100:datasetReferenceDate>2026-01-04</S100:datasetReferenceDate>
        <S100:datasetLanguage>eng</S100:datasetLanguage>
        <S100:datasetAbstract>The abstract of the dataset</S100:datasetAbstract>
        <S100:datasetTopicCategory>oceans</S100:datasetTopicCategory>
        <S100:datasetPurpose>base</S100:datasetPurpose>
        <S100:updateNumber>0</S100:updateNumber>
    </S100:DatasetIdentificationInformation>
    <S124:members>
        <S124:NavwarnPreamble gml:id="CCG.S124.CA01.C.0031.26.0">
            <S124:affectedChartPublications>
                <S124:chartAffected>
                    <S124:chartNumber>1351</S124:chartNumber>
                    <S124:editionDate>2025-04-11</S124:editionDate>
                </S124:chartAffected>
                <S124:language>eng</S124:language>
                <S124:publicationAffected>Île Sainte-Thérèse à/to Pointe à la Meule - Sheet/Feuille 2</S124:publicationAffected>
            </S124:affectedChartPublications>
            <S124:generalArea>
                <S124:locationName>
                    <S124:language>eng</S124:language>
                    <S124:text>Richelieu River and Northern Lake Champlain</S124:text>
                </S124:locationName>
            </S124:generalArea>
            <S124:locality>
                <S124:locationName>
                    <S124:language>eng</S124:language>
                    <S124:text>Saint-Jean-sur-Richelieu</S124:text>
                </S124:locationName>
            </S124:locality>
            <S124:messageSeriesIdentifier>
                <S124:agencyResponsibleForProduction>Canadian Coast Guard</S124:agencyResponsibleForProduction>
                <S124:interoperabilityIdentifier>urn:mrn:CCG.S124.CA01.C.0031.26</S124:interoperabilityIdentifier>
                <S124:nameOfSeries>C</S124:nameOfSeries>
                <S124:nationality>Canada</S124:nationality>
                <S124:warningNumber>31</S124:warningNumber>
                <S124:warningType code="1">Local Navigational Warning</S124:warningType>
                <S124:year>2026</S124:year>
            </S124:messageSeriesIdentifier>
            <S124:navwarnTitle>
                <S124:language>eng</S124:language>
                <S124:text>Marine Works - Construction operations</S124:text>
            </S124:navwarnTitle>
            <S124:intService>true</S124:intService>
            <S124:navwarnTypeGeneral code="19">Works</S124:navwarnTypeGeneral>
            <S124:publicationTime>2026-01-04T12:20:32.389</S124:publicationTime>
            <S124:theReferences xlink:href="#CCG.S124.CA01.C.0031.26.1"/>
        </S124:NavwarnPreamble>
        <S124:NavwarnPart gml:id="CCG.S124.CA01.C.0031.26.1">
            <S124:fixedDateRange>
                <S124:dateStart>
                    <S100:date>2026-01-04</S100:date>
                </S124:dateStart>
            </S124:fixedDateRange>
            <S124:warningInformation>
                <S124:information>
                    <S124:language>eng</S124:language>
                    <S124:text>Construction operations taking place during daylight hours on the retaining wall of Royal Military College Saint-Jean at 45 17.919N 073 15.013W beginning 05 Jan 2026. Turbidity curtains, cofferdams and a barge may be present. </S124:text>
                </S124:information>
                <S124:navwarnTypeDetails code="298">Works in Progress</S124:navwarnTypeDetails>
            </S124:warningInformation>
            <S124:header xlink:href="#CCG.S124.CA01.C.0031.26.0"/>
            <S124:geometry>
                <S100:curveProperty>
                    <S100:Curve gml:id="CCG.S124.CA01.C.0031.26.location.1" srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2">
                        <gml:segments>
                            <gml:LineStringSegment numDerivativesAtStart="0" numDerivativeInterior="0" interpolation="linear">
<gml:posList srsName="https://www.opengis.net/def/crs/EPSG/0/4326" srsDimension="2" count="2">45.299954 -73.250175 45.293549 -73.250278 </gml:posList>
                            </gml:LineStringSegment>
                        </gml:segments>
                    </S100:Curve>
                </S100:curveProperty>
            </S124:geometry>
        </S124:NavwarnPart>
    </S124:members>
</S124:Dataset>
